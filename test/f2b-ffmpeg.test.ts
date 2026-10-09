// Prueba real con el ffmpeg del sistema (se saltea si ffmpeg o ffprobe no están en el PATH): genera un OGG/Opus con lavfi, lo convierte y mide la duración.
// Después lo mismo de punta a punta: el audio generado entra por el turno (con transcriptor falso, sin OpenAI).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_TRANSCRIPT, convertAudio } from '../src/audio.ts';
import { MediaUnreadableError } from '../src/channel/types.ts';
import { botSaid } from '../src/db.ts';
import { makeHarness } from './f2-harness.ts';
import { ASK, ASK_FIRST, ScriptedAudio } from './f2b-audio-helpers.ts';
import { bootApp } from './f2b-app.ts';

const has = (cmd: string) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
const skip = !(has('ffmpeg') && has('ffprobe')) && 'ffmpeg o ffprobe no están en el PATH';
const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;

// Un OGG/Opus de `seconds` segundos (un tono de 440 Hz) hecho con el generador lavfi de ffmpeg: el mismo contenedor y códec que una nota de voz de WhatsApp.
function makeOgg(seconds: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-test-ogg-'));
  try {
    const out = join(dir, 'voz.ogg');
    execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libopus', '-b:a', '24k', out]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Cada prueba convierte en su propio directorio: otras pruebas en paralelo también crean olimpo-audio-* en el temporal del sistema.
const ownTmp = mkdtempSync(join(tmpdir(), 'olimpo-test-conv-'));
after(() => rmSync(ownTmp, { recursive: true, force: true }));
const leftovers = () => readdirSync(ownTmp).filter((f) => f.startsWith('olimpo-audio-'));
async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await new Promise((resolve) => setTimeout(resolve, 25))) if (Date.now() > end) throw new Error('se acabó el tiempo esperando a ffmpeg');
}

test('convertAudio: un OGG/Opus de 3 s sale como mp3 mono de 16 kHz y 32 kbps, con la duración medida por ffprobe, y no quedan temporales', { skip }, async () => {
  const ogg = makeOgg(3);
  assert.equal(Buffer.from(ogg.subarray(0, 4)).toString('latin1'), 'OggS');
  assert.deepEqual(leftovers(), []);
  const before = leftovers();
  const { mp3, seconds } = await convertAudio(ogg, ownTmp);
  assert.ok(seconds > 2.8 && seconds < 3.3, `duración medida: ${seconds}`);
  assert.ok(mp3.length > 1000);
  const head = Buffer.from(mp3.subarray(0, 3)).toString('latin1');
  assert.ok(head === 'ID3' || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0), 'no parece un mp3');
  // Lo que salió: se mide de nuevo, aparte.
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-test-mp3-'));
  try {
    writeFileSync(join(dir, 'salida.mp3'), mp3);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', join(dir, 'salida.mp3')]).toString()) as { streams: { codec_name: string; sample_rate: string; channels: number; bit_rate: string }[] };
    const s = probe.streams[0];
    assert.deepEqual([s.codec_name, s.sample_rate, s.channels], ['mp3', '16000', 1]);
    assert.ok(Math.abs(Number(s.bit_rate) - 32_000) < 3000, `bit_rate ${s.bit_rate}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(leftovers(), before); // los temporales se borraron
});

test('convertAudio: bytes que no son audio (o vacíos) son un audio ilegible, no un error de la instalación, y no quedan temporales', { skip }, async () => {
  const before = leftovers();
  for (const bytes of [new Uint8Array(), new TextEncoder().encode('<html>no soy un audio</html>'), new Uint8Array(5000).fill(7)]) {
    await assert.rejects(convertAudio(bytes, ownTmp), (e: unknown) => e instanceof MediaUnreadableError && e.kind === 'ffmpeg'); // ilegible por la causa que avisa al equipo
  }
  assert.deepEqual(leftovers(), before);
});

test('de punta a punta con ffmpeg real: el audio generado se convierte, se transcribe (falso) y el turno lo ve; uno más largo que max_audio_seconds queda ilegible', { skip }, async () => {
  const h = makeHarness({ audio: new ScriptedAudio({ convert: convertAudio }) });
  const ok = h.sayAudio(CHAT, { bytes: makeOgg(2) });
  await h.clock.advance(sec(3)); // vence la ráfaga: el turno arranca y ffmpeg corre de verdad
  await waitFor(() => (h.db.prepare('SELECT transcript_status AS s FROM messages WHERE id = 1').get() as { s: string }).s !== 'pendiente');
  await h.clock.advance(sec(10));
  assert.equal((h.db.prepare('SELECT text FROM messages WHERE id = 1').get() as { text: string }).text, '(audio) quiero una cancha en Pilar');
  assert.equal(h.texts().length, 1);
  assert.deepEqual(h.channel.downloads, [ok.path]);
  const cost = h.db.prepare("SELECT cost_usd FROM agent_runs WHERE model = 'gpt-transcribe'").get() as { cost_usd: number };
  assert.ok(cost.cost_usd > (1.8 * 0.0045) / 60 && cost.cost_usd < (2.5 * 0.0045) / 60, `costo ${cost.cost_usd}`); // unos 2 s, redondeados hacia arriba

  const long = makeHarness({ audio: new ScriptedAudio({ convert: convertAudio }), settings: { max_audio_seconds: '10' } });
  long.sayAudio(CHAT, { bytes: makeOgg(11) });
  await long.clock.advance(sec(3));
  await waitFor(() => (long.db.prepare('SELECT transcript_status AS s FROM messages WHERE id = 1').get() as { s: string }).s !== 'pendiente');
  await long.clock.advance(sec(10));
  assert.equal(long.audio.transcribed, 0); // no se transcribió: se pasa de max_audio_seconds
  assert.deepEqual(long.texts(), [ASK_FIRST]);
});

test('de punta a punta por main.ts (BOT_LLM=fake): ffmpeg real, transcriptor falso gratis y cerebro falso; el borrador sale a Telegram', { skip }, async () => {
  const a = await bootApp({ shadow: true, env: { BOT_LLM: 'fake' } });
  const path = `/api/files/false_${CHAT}_APP1.oga`;
  a.channel.files.set(path, makeOgg(2));
  await a.post(a.customerEvent(CHAT, '', { media: 'audio', mediaFile: { path, mime: 'audio/ogg; codecs=opus' } }));
  await a.clock.advance(sec(3));
  await waitFor(() => (a.db.prepare('SELECT transcript_status AS s FROM messages WHERE id = 1').get() as { s: string }).s !== 'pendiente');
  await a.clock.advance(sec(10));
  assert.equal((a.db.prepare('SELECT text FROM messages WHERE id = 1').get() as { text: string }).text, `(audio) ${FAKE_TRANSCRIPT}`);
  assert.ok(a.tg.texts.some((t) => t.startsWith('Borrador #1')), 'no llegó el borrador a Telegram');
  assert.equal(a.channel.sendCalls, 0); // modo sombra
  const cost = a.db.prepare("SELECT cost_usd FROM agent_runs WHERE model = 'gpt-transcribe'").get() as { cost_usd: number };
  assert.equal(cost.cost_usd, 0); // el transcriptor falso no gasta
  assert.equal(botSaid(a.db, CHAT, ASK), false); // el borrador no es un pedido de texto: nada salió
  assert.ok(!a.logs.some((l) => l.includes(FAKE_TRANSCRIPT))); // las transcripciones no van a la consola
});
