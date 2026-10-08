// Mandar un aviso sin que su falla (Telegram caído o colgado) frene a quien avisa: queda en la auditoría de todos modos.
import type { Clock } from '../clock.ts';
import { audit } from '../db.ts';
import type { Db } from '../db.ts';
import type { AlertOpts, Notifier } from './types.ts';

const NOTIFY_TIMEOUT_MS = 5_000; // un aviso que no contesta en 5 s se deja de esperar

// Corre una llamada del notificador (aviso, ficha, borrador, toma humana) con tope de 5 s. Nunca tira: si falla o se cuelga, lo anota en la auditoría.
export async function safeNotify(db: Db, clock: Clock, chatId: string | null, f: () => void | Promise<void>): Promise<void> {
  let timer: unknown;
  const timeout = new Promise<'timeout'>((resolve) => { timer = clock.setTimeout(() => resolve('timeout'), NOTIFY_TIMEOUT_MS); });
  try {
    const call = (async () => { await f(); return 'ok' as const; })(); // f arranca ya (no en el próximo turno); si tira, la promesa se rechaza
    if (await Promise.race([call, timeout]) === 'timeout') {
      audit(db, clock.now(), chatId, 'error', 'no pude mandar el aviso: Telegram no contestó en 5 s');
    }
  } catch (e) {
    audit(db, clock.now(), chatId, 'error', `no pude mandar el aviso: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clock.clearTimeout(timer);
  }
}

export async function sendAlert(db: Db, notifier: Notifier, clock: Clock, text: string, opts: AlertOpts & { chatId?: string } = {}): Promise<void> {
  audit(db, clock.now(), opts.chatId ?? null, 'alert', text);
  await safeNotify(db, clock, opts.chatId ?? null, () => notifier.alert(text, { urgent: !!opts.urgent }));
}
