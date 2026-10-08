// Valores configurables con defaults (tabla settings). Se cambian con /set en Telegram o por SQL.
import type { Db } from './db.ts';

// Todo se guarda como texto. "0"/"1" para los interruptores.
export const SETTING_DEFAULTS = {
  kill_switch: '0',
  shadow_mode: '1', // prendido por defecto: los borradores van a Telegram y no se le escribe al cliente
  burst_quiet_ms: '2000',
  burst_max_ms: '8000',
  reply_window_hours: '12', // al prender, se contestan solo las consultas más nuevas que esto
  daily_budget_usd: '2', // REQUIERE INPUT de Lazar: default conservador
  conv_budget_usd: '0.25',
  max_new_chats_per_day: '30',
  bot_start_utc: '', // vacío = todavía no arrancó; se fija en el primer arranque
  outbox_expiry_min: '30',
  typing_ms: '2500', // por globo, con tope
  max_audio_seconds: '600', // un audio más largo que esto no se transcribe: se trata como ilegible
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SETTING_DEFAULTS, key);

const FLAGS: SettingKey[] = ['kill_switch', 'shadow_mode'];
const MIN_AUDIO_SECONDS = 10;

const read = (db: Db, key: string): string | undefined => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const write = (db: Db, key: string, value: string): void =>
  void db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);

export const getSetting = (db: Db, key: SettingKey): string => read(db, key) ?? SETTING_DEFAULTS[key];

// Un valor roto (editado a mano por SQL) no tumba nada: cae al default.
export function getNum(db: Db, key: SettingKey): number {
  const n = Number(getSetting(db, key));
  return getSetting(db, key).trim() !== '' && Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key]);
}
export const getFlag = (db: Db, key: SettingKey): boolean => getSetting(db, key) === '1';

export function setSetting(db: Db, key: string, value: string): void {
  if (!isSettingKey(key)) throw new Error(`clave desconocida: ${key}`);
  if (FLAGS.includes(key) && value !== '0' && value !== '1') throw new Error(`${key} es 0 o 1`);
  if (!FLAGS.includes(key) && !(key === 'bot_start_utc' && value === '') && !(value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)) {
    throw new Error(`${key} tiene que ser un número desde 0`);
  }
  if (key === 'max_audio_seconds' && Number(value) < MIN_AUDIO_SECONDS) throw new Error(`max_audio_seconds tiene que ser ${MIN_AUDIO_SECONDS} o más (un tope menor deja ilegible casi cualquier audio)`);
  write(db, key, value);
}

// Primer arranque: la hora queda fija. Los chats con historia anterior a esta hora arrancan en `humano`.
export function getBotStart(db: Db): number | undefined {
  const v = getSetting(db, 'bot_start_utc');
  return v === '' ? undefined : Number(v);
}
export function ensureBotStart(db: Db, nowMs: number): number {
  const current = getBotStart(db);
  if (current !== undefined) return current;
  write(db, 'bot_start_utc', String(nowMs));
  return nowMs;
}

// Estado interno (por ejemplo el último session.status): misma tabla, prefijo aparte para que /set no lo toque.
export const getState = (db: Db, key: string): string | undefined => read(db, `state.${key}`);
export const setState = (db: Db, key: string, value: string): void => write(db, `state.${key}`, value);
