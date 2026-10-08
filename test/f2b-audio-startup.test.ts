// Audios y reconciliación al prender (F2b): un audio recuperado de la historia de WAHA entra pendiente si trae url, e ilegible si no; el resto de los adjuntos sigue como antes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNREADABLE_AUDIO_TEXT } from '../src/audio.ts';
import { getConversation, unansweredMessages } from '../src/db.ts';
import { createRecovery } from '../src/startup.ts';
import { setState } from '../src/settings.ts';
import { FIRST_TEXT, ScriptedLlm, turnWith } from './f2-helpers.ts';
import { ASK_FIRST } from './f2b-audio-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import type { Harness } from './f2-harness.ts';

const CHAT = '5491155550000@c.us';
const min = (n: number) => n * 60_000;
const hour = (n: number) => n * 3_600_000;
const PATH = '/api/files/false_5491155550000@c.us_AUD1.oga';
const row = (h: Harness, id: number) => ({ ...h.db.prepare('SELECT text, transcript_status AS status, media, media_url AS url, media_mime AS mime FROM messages WHERE id = ?').get(id) }) as { text: string; status: string | null; media: string | null; url: string | null; mime: string | null };

function setup(o: { llm?: ScriptedLlm } = {}) {
  const h = makeHarness({ botStartAgoMs: hour(72), llm: o.llm });
  const recovery = createRecovery({ db: h.db, channel: h.channel, clock: h.clock, notifier: h.notifier, worker: h.worker, onReady: () => {} });
  setState(h.db, 'alive_utc', String(h.clock.now() - min(30)));
  return { h, recovery };
}
const audioInHistory = (h: Harness, id: string, agoMs: number, mediaFile?: { path?: string; mime?: string; error?: boolean }) =>
  h.channel.addHistory(CHAT, { providerMsgId: id, fromMe: false, tsUtcMs: h.clock.now() - agoMs, text: '', media: 'audio', ...(mediaFile ? { mediaFile } : {}) });

test('un audio de la historia con url entra pendiente (path y tipo guardados), sube la versión y, al correr el turno, se transcribe y se contesta', async () => {
  const llm = new ScriptedLlm(() => turnWith([FIRST_TEXT]));
  const { h, recovery } = setup({ llm });
  h.channel.files.set(PATH, new Uint8Array([1, 2, 3]));
  audioInHistory(h, 'false_aud_1', min(10), { path: PATH, mime: 'audio/ogg; codecs=opus' });
  const r = await recovery.reconcile();
  assert.deepEqual(r.scheduled, [CHAT]);
  assert.deepEqual(r.mediaOnly, []); // un audio ya no es "algo que el bot no lee"
  assert.deepEqual(row(h, 1), { text: '', status: 'pendiente', media: 'audio', url: PATH, mime: 'audio/ogg; codecs=opus' });
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, 1);
  assert.equal(h.notifier.alerts.length, 0);
  assert.equal(unansweredMessages(h.db, CHAT).length, 1);
  await h.clock.advance(10_000); // la ráfaga que programó la reconciliación
  assert.equal(h.audio.transcribed, 1);
  assert.match(llm.calls[0].input, /\(audio\) quiero una cancha en Pilar/);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
});

test('un audio de la historia sin url (o con error) entra ilegible: se pide texto por única vez, sin llamar al modelo', async () => {
  const { h, recovery } = setup();
  audioInHistory(h, 'false_aud_1', min(10)); // sin archivo
  const r = await recovery.reconcile();
  assert.deepEqual(r.scheduled, [CHAT]);
  assert.deepEqual(row(h, 1), { text: UNREADABLE_AUDIO_TEXT, status: 'ilegible', media: 'audio', url: null, mime: null });
  await h.clock.advance(10_000);
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.channel.downloads.length, 0);

  const b = setup();
  audioInHistory(b.h, 'false_aud_2', min(10), { path: PATH, mime: 'audio/ogg', error: true });
  await b.recovery.reconcile();
  assert.equal(row(b.h, 1).status, 'ilegible');
});

test('reconciliar dos veces no duplica el audio ni lo pisa; las fotos y videos sin texto siguen avisando en el resumen', async () => {
  const { h, recovery } = setup();
  audioInHistory(h, 'false_aud_1', min(10), { path: PATH, mime: 'audio/ogg' });
  h.channel.addHistory(CHAT, { providerMsgId: 'false_img_1', fromMe: false, tsUtcMs: h.clock.now() - min(9), text: '', media: 'image' });
  const r = await recovery.reconcile();
  assert.deepEqual(r.mediaOnly, [CHAT]);
  assert.match(h.notifier.alerts[0].text, /sin texto.*foto, video.*#1/);
  assert.equal(row(h, 2).media, 'image');
  await recovery.reconcile();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 2);
  assert.equal(row(h, 1).status, 'pendiente');
});
