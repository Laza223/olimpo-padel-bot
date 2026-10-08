// Latido a healthchecks.io: cada 60 s, y solo si la sesión de WhatsApp está WORKING y la base responde.
// Si el bot deja de andar (o la sesión se cae), los pings se cortan y healthchecks avisa por su cuenta: es la alarma que no depende de esta PC.
import type { Clock } from './clock.ts';
import { audit } from './db.ts';
import type { Db } from './db.ts';

const INTERVAL_MS = 60_000;

export interface HeartbeatOptions {
  db: Db;
  clock: Clock;
  url: string; // HEALTHCHECKS_PING_URL; vacío = no hace nada
  isWorking: () => boolean;
  fetch?: typeof fetch;
  intervalMs?: number;
}

export interface Heartbeat {
  tick(): Promise<boolean>; // true si pingueó
  start(): void;
  stop(): void;
}

export function createHeartbeat(o: HeartbeatOptions): Heartbeat {
  const fetchFn = o.fetch ?? fetch;
  let timer: unknown;
  let started = false;
  let stopped = false;
  let failing = false;

  async function tick(): Promise<boolean> {
    if (!o.url || !o.isWorking()) return false;
    try {
      o.db.prepare('SELECT 1 FROM settings LIMIT 1').get(); // la base contesta
    } catch {
      return false;
    }
    try {
      const res = await fetchFn(o.url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      failing = false;
      return true;
    } catch (e) {
      // Se anota una vez por caída (sin la URL, que es un secreto) y se sigue: no hay nada más que hacer desde acá.
      if (!failing) audit(o.db, o.clock.now(), null, 'error', `latido: no pude avisar a healthchecks (${(e instanceof Error ? e.message : String(e)).replaceAll(o.url, '***')})`);
      failing = true;
      return false;
    }
  }

  function loop(): void {
    if (stopped) return;
    void tick().finally(() => {
      if (!stopped) timer = o.clock.setTimeout(loop, o.intervalMs ?? INTERVAL_MS);
    });
  }

  return {
    tick,
    start() {
      if (!o.url || started) return;
      started = true;
      loop();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) o.clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
