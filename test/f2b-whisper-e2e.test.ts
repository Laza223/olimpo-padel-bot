// Prueba real de punta a punta contra el contenedor de Whisper. Se saltea si el server no está levantado o si no hay ffmpeg.
// OGG/Opus (nota de voz de un cliente) → convertAudio (ffmpeg real) → LocalWhisperTranscriber → texto con las palabras del negocio.
// El compose no publica puertos: para esta prueba se levanta una copia del servicio que sí publica uno, solo en 127.0.0.1:
//   docker compose run -d --rm --name whisper-e2e -p 127.0.0.1:18080:8080 whisper     (y al terminar: docker rm -f whisper-e2e)
// Otra dirección: WHISPER_E2E_URL=http://127.0.0.1:<puerto>
// El audio (test/fixtures/voz-cliente.ogg, 29 s) se generó una vez con la voz "Microsoft Sabina Desktop" (es-MX) de Windows (PowerShell, System.Speech, SetOutputToWaveFile con el texto de abajo)
// y se pasó con: ffmpeg -i voz.wav -c:a libopus -b:a 24k -ac 1 -ar 16000 voz-cliente.ogg
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWhisperTranscriber, convertAudio } from '../src/audio.ts';

const URL_E2E = (process.env.WHISPER_E2E_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const has = (cmd: string) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
const up = await fetch(`${URL_E2E}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
const skip = (!(has('ffmpeg') && has('ffprobe')) && 'ffmpeg o ffprobe no están en el PATH') || (!up && `el server de Whisper no está levantado en ${URL_E2E} (ver el comienzo de este archivo)`);

// Lo que dice el audio: "Hola, buenas tardes. Tengo un galpón en Pilar y quiero armar una cancha de pádel techada. Estuve viendo la Full Panorámica y la Panorámica, y me gustaría saber cuál es la diferencia.
// La medida sería 20 por 10, sobre una platea de hormigón que ya tengo hecha. También quiero saber si se puede hacer al aire libre, y si ustedes instalan en Córdoba, porque mi hermano tiene un campo allá. Quedo atento, muchas gracias."
// convertAudio escribe en el directorio temporal del sistema, y f2b-ffmpeg.test.ts (otro proceso, en paralelo) mira que no queden olimpo-audio-* ahí: esta prueba convierte en un directorio propio para no cruzarse.
async function inOwnTmp<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-test-whisper-'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: dir, TMP: dir, TEMP: dir });
  try {
    return await f(dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
}
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

test('Whisper real: una nota de voz OGG/Opus pasa por ffmpeg y vuelve como texto con las palabras del negocio', { skip, timeout: 150_000 }, async (t) => {
  const ogg = new Uint8Array(await readFile(new URL('./fixtures/voz-cliente.ogg', import.meta.url)));
  assert.equal(Buffer.from(ogg.subarray(0, 4)).toString('latin1'), 'OggS');
  const { mp3, seconds } = await inOwnTmp(async (dir) => {
    const out = await convertAudio(ogg);
    assert.deepEqual(readdirSync(dir), []); // no quedan temporales
    return out;
  });
  assert.ok(seconds > 28 && seconds < 31, `duración ${seconds}`);

  const t0 = Date.now();
  const text = (await new LocalWhisperTranscriber({ url: URL_E2E }).transcribe(mp3)).trim();
  t.diagnostic(`Whisper contestó en ${((Date.now() - t0) / 1000).toFixed(1)} s para ${seconds.toFixed(0)} s de audio`);
  t.diagnostic(`texto: ${text}`);

  const heard = norm(text);
  for (const word of ['galpon', 'pilar', 'padel', 'techada', 'full panoramica', 'panoramica', 'platea', 'aire libre', 'cordoba']) {
    assert.ok(heard.includes(word), `no escuchó "${word}": ${text}`);
  }
  assert.match(heard, /20\s*(por|x)\s*10/, `no escuchó "20 por 10": ${text}`);
  assert.ok(heard.includes(norm('Quedo atento')) || heard.includes('muchas gracias'), `terminó mal: ${text}`);
});

test('Whisper real: un audio sin voz (silencio) vuelve vacío y no repite el vocabulario del prompt', { skip, timeout: 60_000 }, async () => {
  // 3 s de silencio como mp3 mono de 16 kHz, igual que lo deja convertAudio.
  const silence = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1 << 20 });
  assert.equal(silence.status, 0);
  const text = (await new LocalWhisperTranscriber({ url: URL_E2E }).transcribe(new Uint8Array(silence.stdout))).trim();
  assert.equal(text, '');
});
