// Escenarios del banco de pruebas: tipos, carga desde evals/scenarios/*.yaml y validación estricta
// (claves desconocidas, regex rotas y ids repetidos fallan al cargar, no a mitad de una corrida cara).
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { LEAD_FIELDS } from '../src/types.ts';
import type { HandoffReason, LeadField, LeadState } from '../src/types.ts';
import { argentinaTimeToUtcMs } from '../src/time.ts';

export interface Persona {
  perfil: string;
  datos_ocultos: Record<string, string>; // lo que el cliente sabe y va soltando; valores siempre como texto
  estilo: string;
  objetivo: string;
}

// Lo que se le exige a la conversación. Todo es opcional, pero tiene que haber al menos una cosa.
export interface Expect {
  // Motivo(s) de derivación que tienen que aparecer (cualquier modo, flag o stop). Una lista = todos. "ninguna" = ninguna derivación.
  derivacion?: HandoffReason | 'ninguna' | HandoffReason[];
  // Alcanza con una de la lista: para cuando hay más de una respuesta aprobada (ej. tono #15 ofrece pasarlo con el equipo).
  derivacion_alguna?: HandoffReason[];
  // A más tardar en el turno N (inclusive; el turno 1 es el primer mensaje del cliente o ráfaga).
  derivacion_antes_del_turno?: number;
  ficha?: Partial<Record<LeadField, string>>; // valor final exacto (sin mayúsculas ni tildes)
  estado?: LeadState; // estado final de la ficha
  nunca_dice?: string[]; // ningún globo del bot coincide con ninguna regex
  dice_alguna?: string[]; // alguna regex coincide con algún globo del bot
  dice_todas?: string[]; // todas las regex coinciden con algún globo del bot
  primer_globo?: string; // regex que tiene que cumplir el primer globo de toda la conversación
  sin_globos?: boolean; // el bot no manda ningún globo en toda la conversación
  material?: string[]; // ids de assets que el bot tiene que haber mandado
  desde_turno?: number; // nunca_dice / dice_* miran solo los globos desde este turno (default 1)
}

export interface Scenario {
  id: string;
  tags: string[];
  hora: string; // hora argentina del primer mensaje, "HH:MM"
  tipo: 'guion' | 'persona';
  mensajes?: string[]; // guion: un turno por elemento; "a || b" = ráfaga
  persona?: Persona;
  max_turnos: number; // tope de turnos del cliente (guion: la cantidad de mensajes; persona: 10 por defecto)
  espera: Expect;
}

// Al estilo de TURN_SCHEMA: `satisfies Record<…, true>` obliga a listar todos los valores del tipo.
const REASONS = {
  listo_para_presupuesto: true, cliente_grande: true, pide_persona: true, enojado: true, pregunta_por_empresa_anterior: true, pide_verificacion: true,
  factura_a: true, regateo: true, fuera_de_politica: true, baja: true, no_es_cliente: true, falla_del_bot: true, audio_ilegible: true,
} satisfies Record<HandoffReason, true>;
const STATES = {
  nuevo: true, calificando: true, listo_para_presupuesto: true, derivado: true, descartado: true, baja: true, no_es_cliente: true,
} satisfies Record<LeadState, true>;

const EXPECT_KEYS = ['derivacion', 'derivacion_alguna','derivacion_antes_del_turno', 'ficha', 'estado', 'nunca_dice', 'dice_alguna', 'dice_todas', 'primer_globo', 'sin_globos', 'material', 'desde_turno'];
const TOP_KEYS = ['id', 'tags', 'hora', 'tipo', 'mensajes', 'persona', 'max_turnos', 'espera'];
const PERSONA_KEYS = ['perfil', 'datos_ocultos', 'estilo', 'objetivo'];
const DEFAULT_PERSONA_TURNS = 10;

// JavaScript no tiene "(?i)" inline: se acepta como prefijo (así lo escribe el contrato) y se traduce al flag.
// Siempre multilínea: "^" vale al principio de cada globo.
export function compileRegex(src: string): RegExp {
  const insensitive = src.startsWith('(?i)');
  return new RegExp(insensitive ? src.slice(4) : src, insensitive ? 'mi' : 'm');
}

// "a || b" → ["a", "b"]: mensajes que el cliente manda seguidos y el bot atiende en un solo turno.
export function splitBurst(s: string): string[] {
  return s.split('||').map((x) => x.trim()).filter(Boolean);
}

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
const isPlainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;

export function parseScenario(raw: unknown, file: string, knownAssets?: string[]): { scenario?: Scenario; errors: string[] } {
  const errors: string[] = [];
  const bad = (msg: string) => errors.push(`${file}: ${msg}`);
  if (!isPlainObject(raw)) return { errors: [`${file}: el archivo tiene que ser un objeto YAML`] };

  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) bad(`clave desconocida "${k}"`);

  const id = raw.id;
  if (!isText(id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) bad('id obligatorio, en minúsculas con guiones');
  else if (id !== basename(file).replace(/\.ya?ml$/, '')) bad(`el id "${id}" tiene que coincidir con el nombre del archivo`);

  if (raw.tags !== undefined && !(Array.isArray(raw.tags) && raw.tags.every(isText))) bad('tags tiene que ser una lista de textos');

  if (!isText(raw.hora)) bad('hora obligatoria ("HH:MM", hora argentina)');
  else {
    try {
      argentinaTimeToUtcMs(raw.hora);
    } catch (e) {
      bad((e as Error).message);
    }
  }

  const tipo = raw.tipo;
  if (tipo !== 'guion' && tipo !== 'persona') bad('tipo tiene que ser guion o persona');

  let mensajes: string[] | undefined;
  let persona: Persona | undefined;
  if (tipo === 'guion') {
    if (raw.persona !== undefined) bad('un guion no lleva persona');
    if (!Array.isArray(raw.mensajes) || raw.mensajes.length === 0 || !raw.mensajes.every((m) => isText(m) && splitBurst(m).length > 0)) {
      bad('mensajes: lista de textos no vacíos (un turno por elemento)');
    } else mensajes = raw.mensajes as string[];
  } else if (tipo === 'persona') {
    if (raw.mensajes !== undefined) bad('una persona no lleva mensajes: los escribe el cliente simulado');
    const p = raw.persona;
    if (!isPlainObject(p)) bad('persona obligatoria (perfil, datos_ocultos, estilo, objetivo)');
    else {
      for (const k of Object.keys(p)) if (!PERSONA_KEYS.includes(k)) bad(`persona: clave desconocida "${k}"`);
      for (const k of ['perfil', 'estilo', 'objetivo']) if (!isText(p[k])) bad(`persona.${k} obligatorio`);
      const hidden = p.datos_ocultos;
      const values = isPlainObject(hidden) ? Object.values(hidden) : [];
      if (!isPlainObject(hidden) || values.length === 0 || !values.every((v) => isText(v) || typeof v === 'number')) {
        bad('persona.datos_ocultos: objeto con al menos un dato (texto o número)');
      } else if (isText(p.perfil) && isText(p.estilo) && isText(p.objetivo)) {
        persona = { perfil: p.perfil, estilo: p.estilo, objetivo: p.objetivo, datos_ocultos: Object.fromEntries(Object.entries(hidden).map(([k, v]) => [k, String(v)])) };
      }
    }
  }

  if (raw.max_turnos !== undefined && !isCount(raw.max_turnos)) bad('max_turnos tiene que ser un entero desde 1');
  const given = isCount(raw.max_turnos) ? raw.max_turnos : undefined;
  if (tipo === 'guion' && mensajes && given !== undefined && given < mensajes.length) bad('max_turnos es menor que la cantidad de mensajes del guion');
  const maxTurnos = given ?? (mensajes ? mensajes.length : DEFAULT_PERSONA_TURNS);

  const espera = parseExpect(raw.espera, maxTurnos, bad, knownAssets);

  if (errors.length || (tipo !== 'guion' && tipo !== 'persona') || !espera) return { errors };
  return { scenario: { id: id as string, tags: (raw.tags as string[] | undefined) ?? [], hora: raw.hora as string, tipo, mensajes, persona, max_turnos: maxTurnos, espera }, errors };
}

function parseExpect(raw: unknown, maxTurnos: number, bad: (m: string) => void, knownAssets?: string[]): Expect | undefined {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    bad('espera obligatoria, con al menos una expectativa');
    return undefined;
  }
  for (const k of Object.keys(raw)) if (!EXPECT_KEYS.includes(k)) bad(`espera: clave desconocida "${k}"`);
  const e = raw as Record<string, unknown>;
  const out: Expect = {};

  if (e.derivacion !== undefined) {
    const list = Array.isArray(e.derivacion) ? e.derivacion : [e.derivacion];
    const valid = list.length > 0 && list.every((r) => typeof r === 'string' && Object.hasOwn(REASONS, r)) || e.derivacion === 'ninguna';
    if (!valid) bad(`espera.derivacion: "ninguna", un motivo o una lista de motivos (${Object.keys(REASONS).join(', ')})`);
    else out.derivacion = e.derivacion as Expect['derivacion'];
  }
  if (e.derivacion_alguna !== undefined) {
    const list = e.derivacion_alguna;
    if (!Array.isArray(list) || list.length < 2 || !list.every((r) => typeof r === 'string' && Object.hasOwn(REASONS, r))) bad(`espera.derivacion_alguna: lista de 2 o más motivos (${Object.keys(REASONS).join(', ')})`);
    else if (e.derivacion !== undefined) bad('espera: derivacion y derivacion_alguna no van juntas');
    else out.derivacion_alguna = list as HandoffReason[];
  }
  if (e.derivacion_antes_del_turno !== undefined) {
    if (!isCount(e.derivacion_antes_del_turno) || e.derivacion_antes_del_turno > maxTurnos) bad(`espera.derivacion_antes_del_turno: entero entre 1 y ${maxTurnos}`);
    else if ((e.derivacion === undefined && e.derivacion_alguna === undefined) || e.derivacion === 'ninguna') bad('espera.derivacion_antes_del_turno necesita una derivación esperada');
    else out.derivacion_antes_del_turno = e.derivacion_antes_del_turno;
  }
  if (e.ficha !== undefined) {
    if (!isPlainObject(e.ficha) || Object.keys(e.ficha).length === 0) bad('espera.ficha: objeto campo → valor');
    else {
      const ficha: Partial<Record<LeadField, string>> = {};
      for (const [k, v] of Object.entries(e.ficha)) {
        if (!(LEAD_FIELDS as readonly string[]).includes(k)) bad(`espera.ficha: campo desconocido "${k}"`);
        else if (!(isText(v) || typeof v === 'number')) bad(`espera.ficha.${k}: valor de texto`);
        else ficha[k as LeadField] = String(v);
      }
      out.ficha = ficha;
    }
  }
  if (e.estado !== undefined) {
    if (typeof e.estado !== 'string' || !Object.hasOwn(STATES, e.estado)) bad(`espera.estado: uno de ${Object.keys(STATES).join(', ')}`);
    else out.estado = e.estado as LeadState;
  }
  for (const k of ['nunca_dice', 'dice_alguna', 'dice_todas'] as const) {
    const v = e[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0 || !v.every(isText)) {
      bad(`espera.${k}: lista de regex (texto)`);
      continue;
    }
    for (const src of v as string[]) {
      try {
        compileRegex(src);
      } catch {
        bad(`espera.${k}: regex inválida "${src}"`);
      }
    }
    out[k] = v as string[];
  }
  if (e.primer_globo !== undefined) {
    try {
      if (!isText(e.primer_globo)) throw new Error('vacío');
      compileRegex(e.primer_globo);
      out.primer_globo = e.primer_globo;
    } catch {
      bad(`espera.primer_globo: regex inválida "${String(e.primer_globo)}"`);
    }
  }
  if (e.sin_globos !== undefined) {
    if (e.sin_globos !== true) bad('espera.sin_globos: solo true');
    else out.sin_globos = true;
    if (e.primer_globo !== undefined || e.dice_alguna !== undefined || e.dice_todas !== undefined) bad('espera.sin_globos contradice primer_globo / dice_alguna / dice_todas');
  }
  if (e.material !== undefined) {
    if (!Array.isArray(e.material) || e.material.length === 0 || !e.material.every(isText)) bad('espera.material: lista de ids de assets');
    else {
      const unknown = knownAssets ? (e.material as string[]).filter((m) => !knownAssets.includes(m)) : [];
      if (unknown.length) bad(`espera.material: ids que no existen en assets: ${unknown.join(', ')}`);
      else out.material = e.material as string[];
    }
  }
  if (e.desde_turno !== undefined) {
    if (!isCount(e.desde_turno) || e.desde_turno > maxTurnos) bad(`espera.desde_turno: entero entre 1 y ${maxTurnos}`);
    else out.desde_turno = e.desde_turno;
  }
  return out;
}

const DEFAULT_DIR = new URL('./scenarios/', import.meta.url);

// Carga todos los .yaml del directorio, ordenados por nombre. Junta todos los errores en un solo mensaje.
export function loadScenarios(dir: URL = DEFAULT_DIR, knownAssets?: string[]): Scenario[] {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const scenarios: Scenario[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let raw: unknown;
    try {
      raw = parse(readFileSync(new URL(f, dir), 'utf8'));
    } catch (e) {
      errors.push(`${f}: YAML inválido (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    const r = parseScenario(raw, f, knownAssets);
    errors.push(...r.errors);
    if (!r.scenario) continue;
    if (seen.has(r.scenario.id)) errors.push(`${f}: id repetido "${r.scenario.id}"`);
    seen.add(r.scenario.id);
    scenarios.push(r.scenario);
  }
  if (errors.length) throw new Error(`escenarios inválidos:\n${errors.map((x) => `  - ${x}`).join('\n')}`);
  if (scenarios.length === 0) throw new Error('no hay escenarios en evals/scenarios/');
  return scenarios;
}

// --only id,id → esos escenarios (en el orden del banco); un id que no existe es un error.
export function selectScenarios(all: Scenario[], only?: string[]): Scenario[] {
  if (!only?.length) return all;
  const missing = only.filter((id) => !all.some((s) => s.id === id));
  if (missing.length) throw new Error(`escenarios que no existen: ${missing.join(', ')}`);
  return all.filter((s) => only.includes(s.id));
}
