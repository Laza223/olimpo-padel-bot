// El presupuesto del CRM: mismo modelo, textos por defecto y validación que el creador (herramientas/creador-presupuesto-OS/src/js/form.js).
// Cambios pedidos por Lazar el 10-oct: pago 70/30, césped 14 mm (la malla queda en 3,2 mm). Nuevo: precio de lista por renglón (la oferta).
// Lo que manda el navegador no se cree: se normaliza acá y los totales se vuelven a calcular en el servidor.
import type { LeadCard } from '../types.ts';

export interface QuoteProduct {
  id: string;
  modelo: string; // uno de MODELOS ('' = sin elegir: no entra al presupuesto)
  nombreCustom: string; // solo si modelo = 'Otro'
  cantidad: number;
  precioUnitario: number;
  precioLista?: number; // > precio: el renglón está en oferta (precio de lista tachado y franja "OFERTA")
}
export interface QuoteItem {
  id: string;
  descripcion: string;
}
export interface QuoteData {
  clienteNombre: string;
  clienteCodigoPais: string;
  clienteTelefono: string;
  clienteLocalidad: string;
  titulo: string;
  productos: QuoteProduct[];
  items: QuoteItem[];
  condicionesPago: string;
  plazoEntrega: string;
  esPrecioGlobal: boolean;
  precioGlobalManual: number;
  precioTotal: number;
  subtotal: number;
  descuentoPct: number;
  descuento: number;
  moneda: 'USD' | 'ARS';
  notasAdicionales: string;
}

// Los modelos del creador, en su orden.
export const MODELOS = [
  'Cancha Panorámica', 'Cancha Full Panorámica', 'Cancha Single', 'Cancha Doble', 'Platea de Hormigón', 'Servicio de Logística', 'Servicio de Instalación', 'Otro',
] as const;
export const CODIGOS_PAIS = ['+54', '+56', '+598', '+595', '+591', '+55', '+51', '+1'] as const;

export const SPECS_CANCHA = [
  'Estructural de Postes de 2 mm de espesor',
  'Luminarias de 33.200 lúmenes',
  'Estructura de malla de 3,2 mm 50 x 50',
  'Protección de salida de puerta y poste de red',
  'Césped 14 mm MULTIFILAMENTO + arena Sílice',
  'Vidrios templados de 10mm',
];
export const SPECS_PLATEA = [
  'Movimiento de suelo y nivelación del terreno',
  'Sembrado de tosca en 10 cm de espesor, nueva nivelación y aplanado',
  'Encofrado de superficie total en medidas de platea (22 x 11 m)',
  'Colocación de reglas en superficie y marcación de niveles',
  'Rellenado del terreno encofrado con Hormigón H-21 fibrilado',
  'Desparramado y alisado del hormigón',
  'Llaneado y cortes de juntas de dilatación',
];
export const CONDICIONES_DEFAULT = 'Se entrega el 70% al inicio de la obra y el 30% restante al finalizar el proyecto.\nInstalación llave en mano.';
export const PLAZO_DEFAULT = '30 a 45 días hábiles a partir de la confirmación del proyecto.';

// Precios aprobados de policy/olimpo.yaml (por id) y las referencias internas que solo se muestran como ayuda al lado del campo, nunca precargadas.
export interface QuotePrices {
  fullPromo: number;
  fullLista: number;
  panoramica: number;
  platea: number;
}
export interface QuoteHints {
  instalacion?: string; // "referencia: USD 2.500 por cancha"
  logistica?: string; // "referencia: BsAs USD 1.500–2.500 · interior USD 3.000–4.000"
}

// Presupuesto vacío, como "Nuevo presupuesto" del creador: un renglón sin elegir y las specs de cancha.
export function emptyQuote(newId: () => string): QuoteData {
  return {
    clienteNombre: '', clienteCodigoPais: '+54', clienteTelefono: '', clienteLocalidad: '', titulo: '',
    productos: [{ id: newId(), modelo: '', nombreCustom: '', cantidad: 1, precioUnitario: 0 }],
    items: SPECS_CANCHA.map((descripcion) => ({ id: newId(), descripcion })),
    condicionesPago: CONDICIONES_DEFAULT, plazoEntrega: PLAZO_DEFAULT, esPrecioGlobal: false, precioGlobalManual: 0,
    precioTotal: 0, subtotal: 0, descuentoPct: 0, descuento: 0, moneda: 'USD', notasAdicionales: '',
  };
}

// ---------- normalizar lo que manda el navegador ----------
const MAX_TEXT = 2000;
const MAX_ROWS = 60;
const str = (x: unknown, max = MAX_TEXT): string => (typeof x === 'string' ? x.slice(0, max) : '');
const num = (x: unknown): number => {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? parseFloat(x) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : 0;
};
const rowId = (x: unknown, fallback: () => string): string => (typeof x === 'string' && /^[\w-]{1,64}$/.test(x) ? x : fallback());
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// Arma un presupuesto válido en forma (nunca tira) a partir de cualquier JSON, con los totales recalculados como `getData()` del creador.
export function normalizeQuote(raw: unknown, newId: () => string): QuoteData {
  const r = isObj(raw) ? raw : {};
  const productos: QuoteProduct[] = (Array.isArray(r.productos) ? r.productos : []).slice(0, MAX_ROWS).filter(isObj).map((p) => {
    const modelo = (MODELOS as readonly string[]).includes(p.modelo as string) ? (p.modelo as string) : '';
    const lista = num(p.precioLista);
    return {
      id: rowId(p.id, newId), modelo, nombreCustom: modelo === 'Otro' ? str(p.nombreCustom, 200) : '',
      cantidad: Math.max(1, Math.min(999, Math.trunc(num(p.cantidad)) || 1)), precioUnitario: num(p.precioUnitario), ...(lista > 0 ? { precioLista: lista } : {}),
    };
  });
  const items: QuoteItem[] = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ROWS).filter(isObj).map((i) => ({ id: rowId(i.id, newId), descripcion: str(i.descripcion, 500) }));
  const esPrecioGlobal = r.esPrecioGlobal === true;
  const precioGlobalManual = num(r.precioGlobalManual);
  const descuentoPct = Math.min(100, num(r.descuentoPct));
  const codigo = str(r.clienteCodigoPais, 8);
  const q: QuoteData = {
    clienteNombre: str(r.clienteNombre, 200).trim(),
    clienteCodigoPais: (CODIGOS_PAIS as readonly string[]).includes(codigo) ? codigo : '+54',
    clienteTelefono: str(r.clienteTelefono, 40).trim(),
    clienteLocalidad: str(r.clienteLocalidad, 200).trim(),
    titulo: str(r.titulo, 300).trim(),
    productos, items,
    condicionesPago: str(r.condicionesPago).trim(),
    plazoEntrega: str(r.plazoEntrega).trim(),
    esPrecioGlobal, precioGlobalManual,
    precioTotal: 0, subtotal: 0, descuentoPct, descuento: 0,
    moneda: r.moneda === 'ARS' ? 'ARS' : 'USD',
    notasAdicionales: str(r.notasAdicionales).trim(),
  };
  return withTotals(q);
}

// Totales como `getData()` del creador: con precio global, el subtotal es ese precio; si no, la suma de cantidad × precio de los renglones elegidos.
export function withTotals(q: QuoteData): QuoteData {
  const validos = q.productos.filter((p) => p.modelo !== '');
  const subtotal = q.esPrecioGlobal ? q.precioGlobalManual : validos.reduce((sum, p) => sum + (p.cantidad || 0) * (p.precioUnitario || 0), 0);
  const descuento = (subtotal * q.descuentoPct) / 100;
  return { ...q, subtotal, descuento, precioTotal: subtotal - descuento };
}

// Lo que va al PDF: solo los renglones con modelo y las specs con texto (como `getData()`).
export const forPdf = (q: QuoteData): QuoteData => ({ ...q, productos: q.productos.filter((p) => p.modelo !== ''), items: q.items.filter((i) => i.descripcion.trim() !== '') });

// Mismas reglas y textos que `validar()` del creador. Devuelve el primer problema, o undefined si se puede guardar, exportar o mandar.
export function validateQuote(q: QuoteData): string | undefined {
  if (!q.clienteNombre.trim()) return 'Ingresá el nombre del cliente';
  if (!q.titulo.trim()) return 'Ingresá el título del presupuesto';
  const validos = q.productos.filter((p) => p.modelo !== '');
  if (validos.length === 0) return 'Agregá al menos un producto o servicio';
  if (!q.esPrecioGlobal && validos.some((p) => !p.precioUnitario || p.precioUnitario <= 0)) return 'Completá el precio de todos los productos';
  return undefined;
}

// ---------- precarga desde la ficha del cliente ----------
const FIELD = (card: LeadCard | undefined, f: keyof LeadCard['fields']): string => card?.fields[f]?.value.trim() ?? '';

// El teléfono del chat (solo los @c.us lo traen; un @lid no es un teléfono) separado en código de país y número.
export function phoneOf(chatId: string): { codigo: string; numero: string } {
  const m = /^(\d{8,15})@c\.us$/.exec(chatId);
  if (!m) return { codigo: '+54', numero: '' };
  const digits = m[1];
  const codigo = [...CODIGOS_PAIS].sort((a, b) => b.length - a.length).find((c) => digits.startsWith(c.slice(1)));
  return codigo ? { codigo, numero: digits.slice(codigo.length - 1) } : { codigo: '+54', numero: digits };
}

const MODEL_FROM_CARD: Record<string, { modelo: string; titulo: [string, string] }> = {
  full_panoramica: { modelo: 'Cancha Full Panorámica', titulo: ['FULL PANORÁMICA', 'FULL PANORÁMICAS'] },
  panoramica: { modelo: 'Cancha Panorámica', titulo: ['PANORÁMICA', 'PANORÁMICAS'] },
};

// El presupuesto armado con lo que juntó el bot. Lo que no está aprobado (instalación, logística, vidrio 12 mm, color especial) entra como renglón SIN precio:
// el creador no deja exportar ni mandar hasta que Lazar lo complete o lo saque. Nunca se inventa un número.
export function quoteFromCard(card: LeadCard | undefined, chatId: string, prices: QuotePrices | undefined, newId: () => string): QuoteData {
  const q = emptyQuote(newId);
  const n = Math.trunc(Number(FIELD(card, 'cantidad_canchas')));
  const canchas = Number.isFinite(n) && n >= 1 && n <= 99 ? n : 1;
  const model = MODEL_FROM_CARD[FIELD(card, 'modelo')];
  const localidad = FIELD(card, 'localidad');
  const provincia = FIELD(card, 'provincia');
  const phone = phoneOf(chatId);
  q.clienteNombre = FIELD(card, 'nombre');
  q.clienteCodigoPais = phone.codigo;
  q.clienteTelefono = phone.numero;
  q.clienteLocalidad = localidad && provincia && localidad.toLowerCase() !== provincia.toLowerCase() ? `${localidad}, ${provincia}` : localidad || provincia;
  q.titulo = `PROYECTO ${canchas} ${canchas === 1 ? 'CANCHA' : 'CANCHAS'} ${model ? model.titulo[canchas === 1 ? 0 : 1] : 'DE PÁDEL'}`;

  const row = (modelo: string, cantidad: number, precioUnitario = 0, extra: Partial<QuoteProduct> = {}): QuoteProduct => ({ id: newId(), modelo, nombreCustom: '', cantidad, precioUnitario, ...extra });
  const productos: QuoteProduct[] = [];
  if (model?.modelo === 'Cancha Full Panorámica') productos.push(row(model.modelo, canchas, prices?.fullPromo ?? 0, prices ? { precioLista: prices.fullLista } : {}));
  else if (model?.modelo === 'Cancha Panorámica') productos.push(row(model.modelo, canchas, prices?.panoramica ?? 0));
  else productos.push(row('', canchas)); // modelo sin definir: lo elige Lazar
  const platea = FIELD(card, 'platea') === 'quiere_que_la_hagamos';
  if (platea) productos.push(row('Platea de Hormigón', canchas, prices?.platea ?? 0));
  productos.push(row('Servicio de Instalación', canchas), row('Servicio de Logística', 1));
  if (FIELD(card, 'vidrio_12mm') === 'si') productos.push(row('Otro', canchas, 0, { nombreCustom: 'Diferencia por vidrio templado de 12 mm' }));
  const color = FIELD(card, 'color_especial');
  if (color) productos.push(row('Otro', 1, 0, { nombreCustom: `Color especial: ${color}`.slice(0, 200) }));
  q.productos = productos;
  q.items = [...SPECS_CANCHA, ...(platea ? SPECS_PLATEA : [])].map((descripcion) => ({ id: newId(), descripcion }));
  return withTotals(q);
}
