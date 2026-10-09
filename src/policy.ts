// Carga los 3 archivos de policy/ (hechos, tono, material) y arma lo que usan el controlador y el cerebro.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { REQUIRED_FIELDS } from './types.ts';
import type { LeadField } from './types.ts';
import type { SupervisorPolicy } from './supervisor/index.ts';
import { GREETINGS, greetingFor } from './time.ts';

export interface Asset {
  id: string;
  tipo: 'real' | 'render';
  archivos: string[];
  texto: string;
  cuando: string;
}

export interface Policy {
  yamlText: string;
  toneText: string;
  assets: Asset[];
  supervisorPolicy: SupervisorPolicy;
  required: LeadField[];
  closingText: string; // lo que se le promete al cliente cuando la ficha queda completa
  eliteAnswerText: string; // respuesta fija si preguntan por la empresa anterior (marca_nueva.son_los_de_elite.texto)
  audioIlegibleText: string; // lo que se manda (sin llamar al modelo) la primera vez que un audio del cliente no se puede escuchar (audio_ilegible.texto)
  minHeightM: number; // altura libre mínima bajo techo (producto.altura_libre_minima_m.valor)
  greetingRules: { greetings: readonly string[]; primerMensaje: string };
  hash: string; // sha256 de los 3 archivos: cambia si cambia cualquiera
}

const DEFAULT_DIR = new URL('../policy/', import.meta.url);
// Mismo texto en Windows y Linux: el prefijo del prompt no debe cambiar por los saltos de línea.
const read = (dir: URL, name: string) => readFileSync(new URL(name, dir), 'utf8').replace(/\r\n/g, '\n');

export function loadPolicy(dir: URL = DEFAULT_DIR): Policy {
  const yamlText = read(dir, 'olimpo.yaml');
  const toneText = read(dir, 'tone.md');
  const assetsText = read(dir, 'assets.yaml');
  const y = parse(yamlText);
  const assets: Asset[] = parse(assetsText)?.assets;

  const closingText: unknown = y?.presupuesto?.plazo_que_se_promete?.texto;
  if (typeof closingText !== 'string' || !closingText.trim()) throw new Error('olimpo.yaml: falta presupuesto.plazo_que_se_promete.texto');
  const eliteAnswerText: unknown = y?.marca_nueva?.son_los_de_elite?.texto;
  if (typeof eliteAnswerText !== 'string' || !eliteAnswerText.trim()) throw new Error('olimpo.yaml: falta marca_nueva.son_los_de_elite.texto');
  const audioIlegibleText: unknown = y?.audio_ilegible?.texto;
  if (typeof audioIlegibleText !== 'string' || !audioIlegibleText.trim()) throw new Error('olimpo.yaml: falta audio_ilegible.texto');
  if (!Array.isArray(y?.precios) || !Array.isArray(y?.numeros_permitidos)) throw new Error('olimpo.yaml: faltan precios o numeros_permitidos');
  if (!Array.isArray(y?.frases_con_numeros_permitidas) || !y.frases_con_numeros_permitidas.every((p: unknown) => typeof p === 'string')) throw new Error('olimpo.yaml: falta frases_con_numeros_permitidas (lista de textos)');
  if (!Array.isArray(assets) || assets.length === 0) throw new Error('assets.yaml: no hay assets');
  const minHeightM: unknown = y?.producto?.altura_libre_minima_m?.valor;
  if (typeof minHeightM !== 'number') throw new Error('olimpo.yaml: falta producto.altura_libre_minima_m.valor');
  const modelNames: unknown = y?.producto?.modelos_que_se_ofrecen;
  if (!Array.isArray(modelNames) || modelNames.length === 0 || !modelNames.every((n) => typeof n === 'string' && n.trim())) throw new Error('olimpo.yaml: falta producto.modelos_que_se_ofrecen (lista de textos)');
  const primerMensaje: unknown = y?.presentacion?.primer_mensaje;

  const approvedPricesUsd: number[] = y.precios.filter((p: { estado?: string }) => p.estado === 'aprobado').map((p: { usd: number }) => p.usd);
  const hash = createHash('sha256').update(yamlText).update('\0').update(toneText).update('\0').update(assetsText).digest('hex');

  return {
    yamlText,
    toneText,
    assets,
    supervisorPolicy: { approvedPricesUsd, allowedNumbers: y.numeros_permitidos, allowedPhrases: y.frases_con_numeros_permitidas, modelNames },
    required: REQUIRED_FIELDS,
    closingText,
    eliteAnswerText,
    audioIlegibleText,
    minHeightM,
    greetingRules: { greetings: GREETINGS, primerMensaje: typeof primerMensaje === 'string' ? primerMensaje : '' },
    hash,
  };
}

// El saludo y la presentación aprobados de la hora ("Buenas tardes, te escribimos de Olimpo Padel."): la primera frase del primer mensaje aprobado.
// Sin primer mensaje en la política (o sin punto que la cierre) no hay nada que anteponer: devuelve undefined, nada inventado.
export function openingText(policy: Policy, nowUtcMs: number): string | undefined {
  const first = /^[^.]*\./.exec(policy.greetingRules.primerMensaje.replace('{saludo}', greetingFor(nowUtcMs)))?.[0];
  return first?.trim() || undefined;
}
