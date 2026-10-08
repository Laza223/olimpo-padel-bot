// Audios del cliente (F2b): ffmpeg (del sistema) los pasa a mp3 mono de 16 kHz y gpt-transcribe los pasa a texto.
// Nada de esto toca el chat: lo usa el worker dentro del turno (src/worker.ts), que baja el archivo, convierte, transcribe y guarda el costo.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import OpenAI, { toFile } from 'openai';
import { TransientLlmError, asTransient } from './brain.ts';
import { MediaUnreadableError } from './channel/types.ts';

// Lo que ve el modelo en lugar del audio.
export const AUDIO_PREFIX = '(audio) ';
export const audioText = (transcript: string): string => `${AUDIO_PREFIX}${transcript}`;
export const UNREADABLE_AUDIO_TEXT = '(audio que no se pudo escuchar)';

// ---------- conversión ----------
export interface ConvertedAudio {
  mp3: Uint8Array;
  seconds: number; // duración medida con ffprobe sobre el mp3
}
export type ConvertAudio = (data: Uint8Array) => Promise<ConvertedAudio>;

const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

// Sin shell. ffmpeg o ffprobe que faltan es un problema de la instalación (error común, se reintenta y avisa); un archivo que no se deja leer es un audio ilegible.
async function exec(cmd: 'ffmpeg' | 'ffprobe', args: string[], timeout: number): Promise<string> {
  try {
    return (await execFileAsync(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'EACCES') throw new Error(`${cmd} no está instalado en el sistema (o no se puede ejecutar)`);
    throw new MediaUnreadableError(`${cmd} no pudo leer el audio`, 'ffmpeg');
  }
}

// Entrada y salida en el directorio temporal con nombre al azar; se borran siempre. Salida: mp3 mono, 16 kHz, 32 kbps.
export const convertAudio: ConvertAudio = async (data) => {
  const base = join(tmpdir(), `olimpo-audio-${randomUUID()}`);
  const input = `${base}.in`;
  const output = `${base}.mp3`;
  try {
    await writeFile(input, data);
    await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', output], FFMPEG_TIMEOUT_MS);
    const seconds = Number((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', output], FFPROBE_TIMEOUT_MS)).trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new MediaUnreadableError('el audio no tiene duración', 'ffmpeg');
    return { mp3: await readFile(output), seconds };
  } finally {
    await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
  }
};

// Al arrancar: si el proceso murió en medio de una conversión quedaron temporales (olimpo-audio-*): se borran los de más de 10 minutos. Nunca tira.
export async function cleanupTempAudio(dir = tmpdir(), olderThanMs = 10 * 60_000, nowMs = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith('olimpo-audio-')) continue;
      try {
        const file = join(dir, name);
        if (nowMs - (await stat(file)).mtimeMs <= olderThanMs) continue;
        await rm(file, { force: true });
        removed++;
      } catch {
        /* uno que no se puede borrar no frena a los demás */
      }
    }
  } catch {
    /* sin directorio temporal legible: no hay nada que limpiar */
  }
  return removed;
}

// ---------- transcripción ----------
export interface Transcriber {
  model: string; // el modelo que queda en agent_runs
  costPerMinuteUsd: number;
  transcribe(mp3: Uint8Array): Promise<string>;
}

export interface AudioDeps {
  convert: ConvertAudio;
  transcriber: Transcriber;
}

export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-transcribe';
export const TRANSCRIBE_USD_PER_MIN = 0.0045; // precio del plan, verificado el 7-oct
// Vocabulario del negocio para que no lo escuche mal.
const VOCAB = ['Olimpo Padel', 'pádel', 'Full Panorámica', 'Panorámica', 'platea', 'galpón', 'techada', 'aire libre', 'césped', 'vidrio templado'];
// gpt-transcribe usa `languages` y `keywords` (doc de OpenAI, 8-oct: `languages` reemplaza a `language`); los modelos anteriores, `language` y `prompt`.
const hintsFor = (model: string) => (model.startsWith('gpt-transcribe') ? { languages: ['es'], keywords: VOCAB } : { language: 'es', prompt: `${VOCAB.join(', ')}.` });
const REJECTED = [400, 413, 415, 422]; // OpenAI no acepta ese audio: no es un error pasajero, es un audio ilegible
// Un 400 por un parámetro que no es el archivo es el pedido mal armado (configuración), no el audio: no se le pide texto al cliente.
const isFileProblem = (e: InstanceType<typeof OpenAI.APIError>) => e.status !== 400 || e.param == null || e.param === 'file';

export class OpenAiTranscriber implements Transcriber {
  model: string;
  costPerMinuteUsd = TRANSCRIBE_USD_PER_MIN;
  #apiKey?: string;
  #client?: OpenAI;

  constructor(opts: { apiKey?: string; model?: string; client?: OpenAI } = {}) {
    this.model = opts.model || DEFAULT_TRANSCRIBE_MODEL;
    this.#apiKey = opts.apiKey;
    this.#client = opts.client;
  }

  async transcribe(mp3: Uint8Array): Promise<string> {
    // El cliente se arma recién acá: con un cerebro claude-* y sin OPENAI_API_KEY el bot prende igual, y el primer audio avisa que falta la clave.
    if (!this.#client) {
      if (!this.#apiKey) throw new TransientLlmError('config', 'Falta OPENAI_API_KEY (va en .env) para transcribir audios');
      this.#client = new OpenAI({ apiKey: this.#apiKey, timeout: 60_000, maxRetries: 2 });
    }
    try {
      const r = await this.#client.audio.transcriptions.create({ file: await toFile(mp3, 'audio.mp3', { type: 'audio/mpeg' }), model: this.model, ...hintsFor(this.model) });
      return typeof r.text === 'string' ? r.text : '';
    } catch (e) {
      const transient = asTransient(e); // el mismo clasificador del cerebro: red, límite, sin saldo y clave o modelo mal puestos
      if (transient) throw transient;
      if (e instanceof OpenAI.APIError && e.status !== undefined && REJECTED.includes(e.status)) {
        if (!isFileProblem(e)) throw new TransientLlmError('config', `OpenAI rechazó el pedido de transcripción (400, parámetro ${e.param}): revisá BOT_TRANSCRIBE_MODEL`);
        throw new MediaUnreadableError(`OpenAI no aceptó el audio (${e.status})`, 'rechazo');
      }
      throw e;
    }
  }
}

// Con BOT_LLM=fake: un texto fijo y gratis, para probar la tubería sin saldo (ffmpeg sí se usa de verdad).
export const FAKE_TRANSCRIPT = '(prueba) quiero una cancha en Pilar';
export class FakeTranscriber implements Transcriber {
  model = DEFAULT_TRANSCRIBE_MODEL;
  costPerMinuteUsd = 0;
  calls = 0;
  async transcribe(): Promise<string> {
    this.calls++;
    return FAKE_TRANSCRIPT;
  }
}

// OpenAI aunque el cerebro sea claude-*. Modelo: BOT_TRANSCRIBE_MODEL (por defecto gpt-transcribe). La clave sale del `env` que se le pasa.
export function createAudio(env: Record<string, string | undefined>, fake: boolean): AudioDeps {
  const get = (k: string) => (env[k] ?? '').trim() || undefined;
  return { convert: convertAudio, transcriber: fake ? new FakeTranscriber() : new OpenAiTranscriber({ apiKey: get('OPENAI_API_KEY'), model: get('BOT_TRANSCRIBE_MODEL') }) };
}

// Costo de una transcripción: por minuto, con la duración redondeada hacia arriba al segundo.
export const transcribeCostUsd = (t: Transcriber, seconds: number): number => (Math.ceil(seconds) * t.costPerMinuteUsd) / 60;
