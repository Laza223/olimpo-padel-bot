// CRM de demostración: levanta SOLO el CRM en 127.0.0.1:8090 con una base temporal y clientes INVENTADOS (nombres y lugares de ejemplo, nada real).
// Uso: pnpm crm:demo   (Ctrl+C para cortar: la base temporal se borra)
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChannel } from '../src/channel/fake.ts';
import { systemClock } from '../src/clock.ts';
import { chatList, dueLabel, promiseDueUtc } from '../src/crm/data.ts';
import { createCrm } from '../src/crm/server.ts';
import {
  addSpend, advanceAnswered, audit, bumpVersion, createConversation, createDraft, editMessage, insertAgentRun, insertMessage, openDb,
  pauseConversation, revokeMessage, saveCard, setMode, setStage,
} from '../src/db.ts';
import type { Db, Stage } from '../src/db.ts';
import { DEDUCED, emptyCard } from '../src/lead.ts';
import { createConsoleNotifier } from '../src/notify/telegram.ts';
import { createOutbox } from '../src/outbox.ts';
import { loadPolicy } from '../src/policy.ts';
import { setSetting, setState } from '../src/settings.ts';
import type { HandoffReason, LeadField, LeadState, Objection, Temperature } from '../src/types.ts';

const PORT = 8090;
const PASSWORD = 'demo-olimpo-2026';
const OLD_CONTACT = 'chat con historia anterior al arranque del bot'; // la marca que busca el CRM
const policy = loadPolicy();
const now = Date.now();
const MIN = 60_000;
const ago = (min: number): number => now - min * MIN;

// ---------- el guion de cada chat ----------
type Who = 'c' | 'b' | 't' | 's'; // cliente, bot, equipo, aviso
interface Msg { who: Who; min: number; text: string; media?: 'image' | 'audio'; unheard?: boolean; edited?: string; revoked?: boolean }
const c = (min: number, text: string, more: Partial<Msg> = {}): Msg => ({ who: 'c', min, text, ...more });
const b = (min: number, text: string): Msg => ({ who: 'b', min, text });
const t = (min: number, text: string): Msg => ({ who: 't', min, text });

interface Spec {
  profile?: string;
  lid?: boolean; // contacto sin número visible
  mode?: 'auto' | 'humano' | 'pausado';
  fields?: Partial<Record<LeadField, string>>;
  deduced?: LeadField[];
  state?: LeadState;
  temp?: Temperature;
  note?: string;
  objections?: Objection[];
  msgs: Msg[]; // en orden, del más viejo al más nuevo
  stage?: { s: Stage; min: number; reason?: string };
  handoff?: { reason: HandoffReason; min: number; mode?: 'stop' | 'flag' };
  draft?: { min: number; bubbles: string[]; material?: string[] };
  quoteSentMin?: number;
  oldContact?: boolean;
  spent?: number;
}

const HELLO = '¡Hola! Te escribe Olimpo Padel. Fabricamos e instalamos canchas de pádel. ¿Me contás cuántas canchas estás pensando?';
const READY = `Gracias, ya tengo todo lo que necesito. ${policy.closingText}`;

// Para las A presupuestar con promesa: busca hace cuántos minutos tuvo que entrar a la etapa para que hoy diga "vence hoy", "vence mañana" o "venció hace…".
function sinceFor(kind: 'hoy' | 'manana' | 'vencido', pick: number): number {
  const hits: number[] = [];
  for (let m = 5; m <= 5 * 24 * 60; m += 5) {
    const d = dueLabel(promiseDueUtc(ago(m)), now);
    if (kind === 'vencido' ? d.late : !d.late && d.text === (kind === 'hoy' ? 'vence hoy' : 'vence mañana')) hits.push(m);
  }
  return hits.length ? hits[Math.min(hits.length - 1, Math.floor(hits.length * pick))] : 60;
}

const S_HOY = sinceFor('hoy', 0.5);
const S_HOY2 = sinceFor('hoy', 0.2);
const S_MANANA = sinceFor('manana', 0.5);
const S_TARDE = sinceFor('vencido', 0.1);
const S_MUY_TARDE = sinceFor('vencido', 0.9);

const CHATS: Spec[] = [
  // ----- el bot armó un borrador y espera el [Mandar] (modo sombra) -----
  {
    fields: { nombre: 'Matías Ferreyra', localidad: 'Villa Aurelia', provincia: 'Buenos Aires', cantidad_canchas: '2', modelo: 'full_panoramica' },
    state: 'calificando', temp: 'tibio', note: 'Ya sabe que quiere la Full Panorámica y 2 canchas. Falta saber si tiene platea.',
    msgs: [b(95, HELLO), c(93, 'Hola, quería info de las canchas panorámicas'), b(92, '¡Buenísimo! ¿En qué localidad y provincia estarías pensando instalarlas?'),
      c(90, 'En Villa Aurelia, Buenos Aires. Serían 2'), b(89, 'Perfecto, 2 canchas. ¿Cuál modelo te interesa, la Panorámica o la Full Panorámica?'),
      c(88, 'La Full Panorámica'), b(87, 'Excelente elección. Una última cosa: ¿ya tenés la platea hecha o todavía no?'), c(7, '¿La platea la hacen ustedes o la tengo que tener lista yo?')],
    draft: { min: 6, bubbles: ['Buena pregunta, Matías. Te lo confirmo enseguida.', 'Mientras tanto, ¿ya tenés la platea hecha o todavía no?'] }, spent: 0.021,
  },
  {
    fields: { nombre: 'Julieta Aguirre', localidad: 'Alto Verde', provincia: 'Córdoba', cantidad_canchas: '1', modelo: 'panoramica', platea: 'tiene', ubicacion: 'techada' },
    state: 'calificando', temp: 'caliente', note: 'Tiene la platea lista y es techada. Pide ver trabajos hechos.',
    msgs: [c(160, 'Buenas tardes! Estoy viendo hacer una cancha en el fondo de casa'), b(159, HELLO), c(150, 'Una sola. En Alto Verde, Córdoba. La platea ya está hecha y es techada'),
      b(149, 'Genial, Julieta. ¿Qué modelo te interesó, la Panorámica o la Full Panorámica?'), c(148, 'La Panorámica'), c(44, '¿Tienen fotos de canchas que hayan hecho?'), c(42, 'Es para decidir con mi marido')],
    draft: { min: 41, bubbles: ['Te paso unas fotos de cómo fabricamos.', 'Si querés, contame cómo es el lugar donde la pondrías.'], material: ['fabricacion_panos'] }, spent: 0.034,
  },
  {
    profile: 'Club Ñandubay Gestión',
    fields: { nombre: 'Rolando Insúa', localidad: 'Ñandubay', provincia: 'Entre Ríos', cantidad_canchas: '4', modelo: 'full_panoramica', uso: 'club' },
    state: 'calificando', temp: 'tibio', objections: ['precio', 'consultar_socio'], note: 'Club con 4 canchas. Lo tiene que hablar con la comisión. Pregunta el precio antes de dar más datos.',
    msgs: [c(300, 'Buenas, somos un club y queremos hacer 4 canchas'), b(299, HELLO), c(290, 'Cuatro, Full Panorámica. En Ñandubay, Entre Ríos'),
      b(289, 'Perfecto, Rolando. ¿La platea ya está o hay que hacerla?'), c(135, 'Antes de seguir: lo tengo que hablar con la comisión. ¿Cuánto sale más o menos?')],
    draft: { min: 133, bubbles: ['Gracias, Rolando. Para pasarte un número serio necesito terminar de entender el proyecto.', '¿La platea ya está o hay que hacerla?'] }, spent: 0.048,
  },
  {
    profile: 'Caro 🎾',
    state: 'nuevo', temp: 'frio',
    msgs: [c(16, 'Hola!! cuánto sale una cancha?')],
    draft: { min: 15, bubbles: ['¡Hola! Te escribe Olimpo Padel. Con gusto te ayudo.', '¿Me decís tu nombre y desde qué localidad escribís?'] },
  },
  // ----- clientes del equipo que escribieron y esperan -----
  {
    mode: 'humano',
    fields: { nombre: 'Bruno Castellano', localidad: 'Sierras de Tolosa', provincia: 'Córdoba', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'quiere_que_la_hagamos', pide_financiacion: 'si' },
    state: 'derivado', temp: 'caliente', objections: ['forma_pago'], note: 'Pidió financiación. Le interesa cerrar este mes.',
    msgs: [t(6200, 'Hola Bruno, te mandé el presupuesto por acá. Cualquier duda me avisás.'), c(6100, 'Gracias! Lo miro con mi socio'), c(86, 'Hola, ¿pudieron ver lo de la financiación? Lo charlé con mi socio y nos interesa'),
      c(85, 'Si se puede en cuotas, avanzamos esta semana')],
    stage: { s: 'seguimiento', min: 5800 }, handoff: { reason: 'listo_para_presupuesto', min: 9000 }, quoteSentMin: 6200, spent: 0.058,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Valeria Domínguez', localidad: 'Puerto Calandria', provincia: 'Santa Fe', cantidad_canchas: '1', modelo: 'panoramica', platea: 'tiene', ubicacion: 'aire_libre' },
    state: 'derivado', temp: 'tibio',
    msgs: [t(1700, 'Hola Valeria, ya te mandé el presupuesto. Fijate si tenés dudas.'), c(1500, 'Gracias, lo veo'), t(1490, 'Dale, cualquier duda me escribís.'), c(224, 'Mandé el dato equivocado', { revoked: true }), c(222, 'Esta es la foto del terreno', { media: 'image' }), c(221, 'Para que vean si entra la cancha', { edited: 'Para que vean si entra la cancha completa' })],
    stage: { s: 'presupuestado', min: 1700 }, handoff: { reason: 'listo_para_presupuesto', min: 2600 }, quoteSentMin: 1700, spent: 0.031,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Ezequiel Montoya', localidad: 'Campo Quemado', provincia: 'Mendoza', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'no_tiene' },
    state: 'derivado', temp: 'caliente', note: 'Mandó audios. Todavía no confirmó si quiere que hagamos la platea.',
    msgs: [b(S_HOY2 + 30, HELLO), c(S_HOY2 + 20, 'Hola, 2 canchas full panorámica en Campo Quemado, Mendoza. No tengo platea'), b(S_HOY2, READY), c(22, '', { media: 'audio', unheard: true })],
    stage: { s: 'a_presupuestar', min: S_HOY2 }, handoff: { reason: 'listo_para_presupuesto', min: S_HOY2 }, spent: 0.044,
  },
  {
    fields: { nombre: 'Lucía Paredes', localidad: 'San Ramiro', provincia: 'Tucumán', cantidad_canchas: '1' },
    state: 'calificando', temp: 'tibio',
    msgs: [b(300, HELLO), c(298, 'Hola, una cancha. Soy de San Ramiro, Tucumán'), b(297, '¡Genial, Lucía! ¿Qué modelo te interesó, la Panorámica o la Full Panorámica?'), c(36, '¿Cuál es la diferencia entre las dos?')],
    spent: 0.012,
  },
  // ----- A presupuestar -----
  {
    mode: 'humano',
    fields: { nombre: 'Hernán Quiroga', localidad: 'Lomas del Sur', provincia: 'Buenos Aires', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'la_hace_cliente', ubicacion: 'techada', altura_libre_m: '7' },
    state: 'derivado', temp: 'caliente', note: 'Techada, 7 m de altura libre. La platea la hace él.',
    msgs: [b(S_HOY + 40, HELLO), c(S_HOY + 30, 'Hola! 2 canchas, Full Panorámica, en Lomas del Sur, Buenos Aires. La platea la hago yo'), b(S_HOY + 20, 'Perfecto. ¿Va techada o al aire libre?'), c(S_HOY + 10, 'Techada, con 7 metros de altura libre'), b(S_HOY, READY)],
    stage: { s: 'a_presupuestar', min: S_HOY }, handoff: { reason: 'listo_para_presupuesto', min: S_HOY }, spent: 0.051,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Agustina Roldán', localidad: 'Costa Esmeralda del Sur', provincia: 'Buenos Aires', cantidad_canchas: '1', modelo: 'panoramica', platea: 'tiene' },
    deduced: ['provincia'], state: 'derivado', temp: 'tibio',
    msgs: [c(S_MANANA + 5, 'Buenas! Quiero una cancha panorámica en Costa Esmeralda del Sur. Ya tengo la platea'), b(S_MANANA, READY)],
    stage: { s: 'a_presupuestar', min: S_MANANA }, handoff: { reason: 'listo_para_presupuesto', min: S_MANANA }, spent: 0.019,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Sebastián Lombardi', localidad: 'Villa Soledad', provincia: 'Santa Fe', cantidad_canchas: '3', modelo: 'full_panoramica', platea: 'quiere_que_la_hagamos', uso: 'inversion' },
    state: 'derivado', temp: 'caliente', objections: ['plazo'], note: 'Inversión: 3 canchas. Pregunta por el plazo de obra.',
    msgs: [b(S_TARDE + 40, HELLO), c(S_TARDE + 30, 'Hola, 3 canchas full panorámica en Villa Soledad, Santa Fe. Quiero que hagan también la platea. Es una inversión'), b(S_TARDE, READY), c(S_TARDE - 2, 'Perfecto, quedo atento'), b(S_TARDE - 3, 'Cualquier cosa me avisás por acá.')],
    stage: { s: 'a_presupuestar', min: S_TARDE }, handoff: { reason: 'cliente_grande', min: S_TARDE }, spent: 0.062,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Paula Echagüe', localidad: 'El Mangrullo', provincia: 'Entre Ríos', cantidad_canchas: '2', modelo: 'panoramica', platea: 'no_tiene' },
    state: 'derivado', temp: 'tibio',
    msgs: [b(S_MUY_TARDE + 20, HELLO), c(S_MUY_TARDE + 10, 'Hola, 2 canchas panorámicas en El Mangrullo, Entre Ríos. No tenemos platea todavía'), b(S_MUY_TARDE, READY)],
    stage: { s: 'a_presupuestar', min: S_MUY_TARDE }, handoff: { reason: 'listo_para_presupuesto', min: S_MUY_TARDE }, spent: 0.027,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Federico Maldonado', localidad: 'Colonia La Aurora', provincia: 'Córdoba', cantidad_canchas: '1' },
    state: 'derivado', temp: 'tibio', note: 'Pidió hablar con una persona antes de dar más datos.',
    msgs: [b(300, HELLO), c(290, 'Hola, una cancha en Colonia La Aurora, Córdoba'), b(289, '¡Genial! ¿Qué modelo te interesó?'), c(200, 'Prefiero hablar con una persona, ¿me llaman?'), b(199, 'Claro, Federico. Ya le aviso al equipo para que te contacte por acá.')],
    stage: { s: 'a_presupuestar', min: 198 }, handoff: { reason: 'pide_persona', min: 198 }, spent: 0.015,
  },
  // ----- Presupuestados -----
  {
    mode: 'humano',
    fields: { nombre: 'Natalia Barrionuevo', localidad: 'Villa Tamarindo', provincia: 'Buenos Aires', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'la_hace_cliente' },
    state: 'derivado', temp: 'caliente',
    msgs: [b(3200, READY), t(1560, 'Hola Natalia, te mandé el presupuesto por acá. Cualquier duda me avisás.')],
    stage: { s: 'presupuestado', min: 1560 }, handoff: { reason: 'listo_para_presupuesto', min: 3150 }, quoteSentMin: 1560, spent: 0.033,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Gustavo Ibáñez', localidad: 'Puerto Tala', provincia: 'Corrientes', cantidad_canchas: '1', modelo: 'panoramica', platea: 'tiene' },
    state: 'derivado', temp: 'tibio',
    msgs: [b(6500, READY), t(4400, 'Gustavo, te dejé el presupuesto en el chat. Cualquier consulta me escribís.')],
    stage: { s: 'presupuestado', min: 4400 }, handoff: { reason: 'listo_para_presupuesto', min: 6450 }, quoteSentMin: 4400, spent: 0.025,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Marcela Sandoval', localidad: 'Alto Verde', provincia: 'Córdoba', cantidad_canchas: '2', modelo: 'panoramica', platea: 'no_tiene' },
    state: 'derivado', temp: 'frio', objections: ['pensarlo'],
    msgs: [b(11000, READY), t(8700, 'Hola Marcela, ya te mandé el presupuesto.'), c(8000, 'Gracias, lo vemos y te aviso'), t(7990, 'Dale, quedo atenta.')],
    stage: { s: 'presupuestado', min: 8700 }, handoff: { reason: 'listo_para_presupuesto', min: 10900 }, quoteSentMin: 8700, spent: 0.029,
  },
  // ----- Seguimiento -----
  {
    mode: 'humano',
    fields: { nombre: 'Ariel Cabrera', localidad: 'San Anselmo', provincia: 'Mendoza', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'quiere_que_la_hagamos', pide_financiacion: 'si' },
    state: 'derivado', temp: 'caliente', objections: ['forma_pago'],
    msgs: [t(14000, 'Ariel, te mandé el presupuesto.'), c(13000, 'Me gustó. ¿Se puede pagar en cuotas?'), t(12990, 'Lo vemos y te cuento.'), c(2900, 'Quedamos en hablar hoy?'), t(2890, 'Sí, a la tarde te escribo con lo de las cuotas.')],
    stage: { s: 'seguimiento', min: 12990 }, handoff: { reason: 'listo_para_presupuesto', min: 15000 }, quoteSentMin: 14000, spent: 0.047,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Silvana Ledesma', localidad: 'Barrio Los Jacarandás', provincia: 'Buenos Aires', cantidad_canchas: '1', modelo: 'panoramica', platea: 'tiene', ubicacion: 'techada' },
    state: 'derivado', temp: 'tibio',
    msgs: [t(9000, 'Silvana, te mandé el presupuesto por acá.'), c(8800, '¿Podrían venir a ver el lugar?'), t(8790, 'Sí, lo coordinamos. ¿Qué días tenés libres?'), c(8600, 'Los sábados a la mañana'), t(8590, 'Perfecto, te confirmo.')],
    stage: { s: 'seguimiento', min: 8790 }, handoff: { reason: 'listo_para_presupuesto', min: 9900 }, quoteSentMin: 9000, spent: 0.036,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Joaquín Pereyra', localidad: 'Valle Hermoso del Sur', provincia: 'Salta', cantidad_canchas: '3', modelo: 'full_panoramica', platea: 'la_hace_cliente', uso: 'club' },
    state: 'derivado', temp: 'tibio', objections: ['consultar_socio'],
    msgs: [t(20000, 'Joaquín, te mandé el presupuesto de las 3 canchas.'), c(19000, 'Lo charlo con la comisión y te aviso'), t(18990, 'Dale, gracias.')],
    stage: { s: 'seguimiento', min: 19000 }, handoff: { reason: 'cliente_grande', min: 21000 }, quoteSentMin: 20000, spent: 0.055,
  },
  // ----- Cliente -----
  {
    mode: 'humano',
    fields: { nombre: 'Diego Tapia', localidad: 'Ñandubay Chico', provincia: 'Entre Ríos', cantidad_canchas: '1', modelo: 'full_panoramica', platea: 'tiene' },
    state: 'derivado', temp: 'caliente',
    msgs: [t(30000, 'Diego, te mandé el presupuesto.'), c(29000, 'Aceptamos. ¿Cómo seguimos?'), t(28990, '¡Genial! Te paso los pasos para avanzar.')],
    stage: { s: 'cliente', min: 28990 }, handoff: { reason: 'listo_para_presupuesto', min: 31000 }, quoteSentMin: 30000, spent: 0.04,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Romina Luna', localidad: 'Puerto Calandria', provincia: 'Santa Fe', cantidad_canchas: '2', modelo: 'panoramica', platea: 'la_hace_cliente' },
    state: 'derivado', temp: 'caliente',
    msgs: [t(40000, 'Romina, te mandé el presupuesto.'), c(39000, 'Perfecto, avanzamos'), t(38990, '¡Bienvenida a Olimpo Padel!')],
    stage: { s: 'cliente', min: 38990 }, handoff: { reason: 'listo_para_presupuesto', min: 41000 }, quoteSentMin: 40000, spent: 0.038,
  },
  // ----- Perdido -----
  {
    mode: 'humano',
    fields: { nombre: 'Leandro Giménez', localidad: 'Campo Quemado', provincia: 'Mendoza', cantidad_canchas: '1', modelo: 'panoramica', platea: 'no_tiene' },
    state: 'derivado', temp: 'frio', objections: ['precio'],
    msgs: [t(15000, 'Leandro, te mandé el presupuesto.'), c(14500, 'Se me va de presupuesto, gracias igual'), t(14490, 'Gracias a vos, cualquier cosa nos escribís.')],
    stage: { s: 'perdido', min: 14490, reason: 'Precio' }, handoff: { reason: 'listo_para_presupuesto', min: 16000 }, quoteSentMin: 15000, spent: 0.02,
  },
  {
    mode: 'humano',
    fields: { nombre: 'Mariela Cortés', localidad: 'Sierras de Tolosa', provincia: 'Córdoba', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'tiene' },
    state: 'derivado', temp: 'frio',
    msgs: [t(25000, 'Mariela, te mandé el presupuesto.'), c(24000, 'Ya cerramos con otro proveedor, gracias'), t(23990, 'Gracias por avisarnos, que les vaya muy bien.')],
    stage: { s: 'perdido', min: 23990, reason: 'Eligió a otro' }, handoff: { reason: 'listo_para_presupuesto', min: 26000 }, quoteSentMin: 25000, spent: 0.03,
  },
  // ----- Descartado -----
  {
    profile: 'Vidrios del Plata (ejemplo)',
    mode: 'humano', state: 'no_es_cliente', temp: 'frio',
    msgs: [c(9000, 'Buenas tardes, les ofrecemos vidrio templado para sus obras. ¿Con quién hablo?'), b(8999, 'Hola, gracias por escribir. Por ahora no necesitamos proveedores.')],
    stage: { s: 'descartado', min: 8999, reason: 'Otro' }, handoff: { reason: 'no_es_cliente', min: 8999 },
  },
  {
    mode: 'humano',
    fields: { nombre: 'Esteban Navarro', localidad: 'Puerto Tala', provincia: 'Corrientes' },
    state: 'baja', temp: 'frio',
    msgs: [b(12000, HELLO), c(11900, 'No me escriban más, por favor', { edited: 'No me escriban más, por favor.' }), b(11899, 'Listo, no te escribimos más. ¡Gracias!')],
    stage: { s: 'descartado', min: 11899 }, handoff: { reason: 'baja', min: 11899 }, spent: 0.008,
  },
  // ----- Con el bot, calificando -----
  {
    fields: { nombre: 'Tamara Vidal', localidad: 'Villa Aurelia', provincia: 'Buenos Aires' },
    state: 'calificando', temp: 'tibio',
    msgs: [c(30, 'Hola! Me pasaron el contacto de ustedes'), b(29, HELLO), c(14, 'Pensaba en dos'), b(13, 'Perfecto, Tamara. ¿Qué modelo te interesó, la Panorámica o la Full Panorámica?')], spent: 0.014,
  },
  {
    profile: 'Pablo',
    state: 'nuevo', temp: 'frio',
    msgs: [c(3, 'Buenas'), b(2, HELLO)],
  },
  {
    fields: { nombre: 'Ornella Funes' },
    state: 'calificando', temp: 'frio',
    msgs: [c(180, 'Hola, soy Ornella'), b(179, HELLO), c(170, 'Todavía estoy viendo'), b(169, 'Sin apuro, Ornella. Cuando quieras seguimos.')], spent: 0.009,
  },
  {
    fields: { nombre: 'Cristian Beltrán', localidad: 'Alto Verde', provincia: 'Córdoba', cantidad_canchas: '1' },
    state: 'calificando', temp: 'tibio',
    msgs: [b(20, HELLO), c(18, 'Hola, una cancha en Alto Verde, Córdoba'), b(17, 'Perfecto. ¿Va techada o al aire libre?'), c(4, 'Al aire libre, la verdad que no sé qué conviene')], spent: 0.011,
  },
  // ----- contactos viejos, con el equipo, pausado -----
  {
    mode: 'humano', state: 'calificando', temp: 'frio', oldContact: true,
    fields: { nombre: 'Gerardo Acosta' },
    msgs: [c(4300, 'Gracias por el dato de la semana pasada'), t(4290, 'De nada, un abrazo.')],
  },
  {
    mode: 'humano', lid: true, state: 'calificando', temp: 'frio', oldContact: true,
    msgs: [c(7000, 'Hola, ¿esta es la línea que antes era de otro número?'), t(6990, 'Sí, es esta. ¿En qué te puedo ayudar?')],
  },
  {
    mode: 'humano',
    fields: { nombre: 'Fernanda Ríos', localidad: 'Barrio Los Jacarandás', provincia: 'Buenos Aires', cantidad_canchas: '1' },
    state: 'calificando', temp: 'tibio',
    msgs: [b(700, HELLO), c(690, 'Hola, una cancha. Barrio Los Jacarandás, Buenos Aires'), t(500, 'Hola Fernanda, soy del equipo. Te llamo mañana a la mañana, ¿te viene bien?'), c(480, 'Sí, perfecto')], spent: 0.017,
  },
  {
    mode: 'pausado', state: 'calificando', temp: 'tibio',
    fields: { nombre: 'Lautaro Medina', localidad: 'Puerto Calandria', provincia: 'Santa Fe', cantidad_canchas: '2' },
    msgs: [b(240, HELLO), c(235, 'Hola, 2 canchas en Puerto Calandria, Santa Fe'), c(52, '¿Siguen ahí?')], spent: 0.019,
  },
];

// ---------- base temporal ----------
const dir = mkdtempSync(join(tmpdir(), 'olimpo-crm-demo-'));
const db: Db = openDb(join(dir, 'demo.sqlite'));
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try { db.close(); } catch { /* ya cerrada */ }
  rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

setSetting(db, 'shadow_mode', '1'); // modo sombra prendido: los borradores esperan el [Mandar]
setSetting(db, 'kill_switch', '0');

const KIND: Record<Who, 'customer' | 'bot' | 'team' | 'system'> = { c: 'customer', b: 'bot', t: 'team', s: 'system' };
CHATS.forEach((s, k) => {
  const i = k + 1;
  const chatId = s.lid ? `2800000000000${String(i).padStart(2, '0')}@lid` : `54911555500${String(i).padStart(2, '0')}@c.us`;
  const lastMin = Math.min(...s.msgs.map((m) => m.min));
  createConversation(db, { chatId, session: 'default', mode: 'auto', nowMs: ago(lastMin), profileName: s.profile });

  const card = emptyCard();
  for (const [f, value] of Object.entries(s.fields ?? {}) as [LeadField, string][]) {
    card.fields[f] = { value, evidenceMsgId: s.deduced?.includes(f) ? `${DEDUCED}${s.fields?.localidad ?? ''}` : 'm1' };
  }
  card.state = s.state ?? 'calificando';
  card.temperature = s.temp ?? 'frio';
  card.teamNote = s.note ?? '';
  card.objections = s.objections ?? [];
  saveCard(db, chatId, card);

  const oldest = Math.max(...s.msgs.map((m) => m.min));
  const msgs: Msg[] = [{ who: 's', min: oldest + 1, text: 'Chat de ejemplo: datos inventados para probar el CRM.' }, ...s.msgs];
  const ids = msgs.map((m, j) => {
    const { id } = insertMessage(db, {
      session: 'default', providerMsgId: `demo-${i}-${j}`, chatId, author: KIND[m.who], text: m.text, tsUtcMs: ago(m.min),
      ...(m.media ? { media: m.media } : {}), ...(m.unheard ? { transcriptStatus: 'pendiente' as const } : {}),
    });
    if (m.edited) editMessage(db, id, m.edited);
    if (m.revoked) revokeMessage(db, id);
    return id;
  });
  // Contestado = todo lo anterior a la tanda final de mensajes del cliente (los que siguen sin respuesta).
  let tail = msgs.length;
  while (tail > 0 && msgs[tail - 1].who === 'c') tail--;
  if (tail > 0) advanceAnswered(db, chatId, ids[tail - 1]);

  const version = bumpVersion(db, chatId, ago(lastMin));
  if (s.mode === 'humano') setMode(db, chatId, 'humano');
  if (s.mode === 'pausado') pauseConversation(db, chatId, 'budget', ago(lastMin));
  if (s.stage) setStage(db, chatId, s.stage.s, ago(s.stage.min), s.stage.reason);
  if (s.handoff) audit(db, ago(s.handoff.min), chatId, 'handoff', `${s.handoff.reason} (${s.handoff.mode ?? 'stop'}, prioridad normal)`);
  if (s.quoteSentMin !== undefined) {
    setState(db, `quote_sent_utc.${chatId}`, String(ago(s.quoteSentMin)));
    audit(db, ago(s.quoteSentMin), chatId, 'command', 'presupuesto_mandado (CRM)');
  }
  if (s.stage && (['seguimiento', 'cliente', 'perdido'].includes(s.stage.s) || s.stage.reason)) audit(db, ago(s.stage.min), chatId, 'command', `etapa: sin etapa → ${s.stage.s}${s.stage.reason ? ` (${s.stage.reason})` : ''} (CRM)`);
  if (s.oldContact) audit(db, ago(oldest + 2), chatId, 'takeover', `${OLD_CONTACT} (${s.msgs.length} mensajes)`);
  if (s.draft) {
    createDraft(db, { chatId, contextVersion: version, bubbles: s.draft.bubbles, material: s.draft.material ?? [], nowMs: ago(s.draft.min), answersUpto: ids[ids.length - 1] });
  }
  if (s.spent) addSpend(db, chatId, s.spent);
});

// El gasto de hoy: unas corridas del bot repartidas en la última hora.
for (let j = 0; j < 14; j++) {
  insertAgentRun(db, {
    chatId: '54911555500' + String(1 + (j % 4)).padStart(2, '0') + '@c.us', tsUtc: ago(2 + j * 4), model: 'demo', effort: 'low', policyHash: 'demo',
    inputTokens: 3000, cachedTokens: 2000, outputTokens: 220, costUsd: 0.027, latencyMs: 1800, violations: [], usedFallback: false,
  });
}

// ---------- servidor: solo el CRM ----------
// La cola de salida es la de verdad, con un WhatsApp de mentira: lo que se "manda" (un presupuesto, un borrador) aparece en el chat y no sale a ningún lado.
const notifier = createConsoleNotifier(db);
const outbox = createOutbox({ db, channel: new FakeChannel(), notifier, clock: systemClock });
const controls = () => ({
  worker: { onCustomerMessage: () => {}, rescan: () => {} },
  kickOutbox: () => outbox.kick(),
  session: { current: () => 'WORKING', qr: async () => ({ data: new Uint8Array(), mimetype: 'image/png' }) },
});
// El PDF lo arma el Chrome de la notebook (o el de CHROMIUM_PATH).
const WINDOWS_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chromiumPath = process.env.CHROMIUM_PATH?.trim() || (existsSync(WINDOWS_CHROME) ? WINDOWS_CHROME : undefined);
const crm = createCrm({
  db, clock: systemClock, controls, notifier, assets: policy.assets, closingText: policy.closingText, password: PASSWORD,
  quotePrices: policy.quotePrices, quoteHints: policy.quoteHints, quoteDir: join(dir, 'presupuestos'), chromiumPath,
});
if (crm.disabledReason) throw new Error(crm.disabledReason);

const server = createServer((req, res) => {
  if (crm.handle(req, res)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No existe.');
});
server.listen(PORT, '127.0.0.1', () => {
  const l = chatList(db, Date.now(), policy.closingText, 'ahora');
  console.log('CRM de demostración (clientes inventados, base temporal)');
  console.log(`  Dirección: http://127.0.0.1:${PORT}/crm/`);
  console.log(`  Clave:     ${PASSWORD}`);
  console.log(`  PDF:       ${chromiumPath ?? 'sin Chrome (CHROMIUM_PATH): "Ver PDF" anda, bajar o mandar el PDF no'}`);
  console.log(`  ${CHATS.length} chats de ejemplo, ${l.counts.ahora} para "Hacer ahora". Ctrl+C para cortar (la base temporal se borra).`);
});
