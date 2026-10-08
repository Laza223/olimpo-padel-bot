// Hora argentina con Intl: nunca depende de la zona de la PC (la notebook de Lazar sale de casa).
const AR = 'America/Argentina/Buenos_Aires';
const AR_OFFSET_H = 3; // Argentina es UTC-3 todo el año (sin horario de verano)

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: AR, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

function parts(nowUtcMs: number): { h: number; m: number } {
  const p = Object.fromEntries(fmt.formatToParts(nowUtcMs).map((x) => [x.type, x.value]));
  return { h: Number(p.hour) % 24, m: Number(p.minute) };
}

export function argentinaHour(nowUtcMs: number): number {
  return parts(nowUtcMs).h;
}

// "14:03"
export function argentinaClock(nowUtcMs: number): string {
  const { h, m } = parts(nowUtcMs);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const GREETINGS = ['Buen día', 'Buenas tardes', 'Buenas noches'] as const;

// 06–12:59 Buen día · 13–19:59 Buenas tardes · 20–05:59 Buenas noches
export function greetingFor(nowUtcMs: number): (typeof GREETINGS)[number] {
  const h = argentinaHour(nowUtcMs);
  if (h >= 6 && h < 13) return GREETINGS[0];
  if (h >= 13 && h < 20) return GREETINGS[1];
  return GREETINGS[2];
}

// "22:30" hora argentina del día de `baseUtcMs` → ms UTC. Para fijar la hora en el chat y en el banco de pruebas.
export function argentinaTimeToUtcMs(hhmm: string, baseUtcMs = Date.now()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`hora inválida "${hhmm}" (formato HH:MM)`);
  const day = new Date(baseUtcMs - AR_OFFSET_H * 3_600_000); // el día de hoy en Argentina
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Number(m[1]) + AR_OFFSET_H, Number(m[2]));
}
