import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideHandoffs } from '../src/handoff.ts';
import { emptyCard } from '../src/lead.ts';
import type { HandoffDecision, LeadCard, ModelTurn } from '../src/types.ts';
import { cardWith, field, modelTurn, withSignals } from './helpers.ts';

type Args = { before?: LeadCard; after?: LeadCard; turn?: ModelTurn; customerText?: string };
const decide = ({ before = emptyCard(), after = before, turn = modelTurn(), customerText = '' }: Args = {}) =>
  decideHandoffs({ before, after, turn, customerText });
const only = (h: HandoffDecision[]) => {
  assert.equal(h.length, 1, JSON.stringify(h));
  return h[0];
};
const flags = (negotiatingCount: number, offKnowledgeCount: number, card = emptyCard()): LeadCard => ({ ...card, flags: { negotiatingCount, offKnowledgeCount } });

test('nada que avisar → sin derivaciones', () => {
  assert.deepEqual(decide(), []);
});

test('listo_para_presupuesto: stop, normal (alta si es caliente)', () => {
  const before = cardWith(['platea']);
  assert.deepEqual(only(decide({ before, after: cardWith() })), { reason: 'listo_para_presupuesto', priority: 'normal', mode: 'stop' });
  const caliente = cardWith([], { plazo_deseado: field('2 meses', 'm1'), quien_decide: field('él', 'm1') });
  assert.deepEqual(only(decide({ before, after: caliente })), { reason: 'listo_para_presupuesto', priority: 'alta', mode: 'stop' });
});

test('listo_para_presupuesto solo cuando la ficha pasa a lista en este turno', () => {
  assert.deepEqual(decide({ before: cardWith(), after: cardWith() }), []);
  assert.deepEqual(decide({ before: cardWith(['platea']), after: cardWith(['platea']) }), []);
});

test('cliente_grande: 3 o más canchas, o club → alta, flag, una sola vez', () => {
  const tres: LeadCard = { ...emptyCard(), fields: { cantidad_canchas: field('3', 'm1') } };
  assert.deepEqual(only(decide({ after: tres })), { reason: 'cliente_grande', priority: 'alta', mode: 'flag' });
  const club: LeadCard = { ...emptyCard(), fields: { uso: field('club', 'm1') } };
  assert.deepEqual(only(decide({ after: club })), { reason: 'cliente_grande', priority: 'alta', mode: 'flag' });
  const dos: LeadCard = { ...emptyCard(), fields: { cantidad_canchas: field('2', 'm1') } };
  assert.deepEqual(decide({ after: dos }), []);
  // ya avisado en un turno anterior: no se repite
  assert.deepEqual(decide({ before: { ...club, notified: ['cliente_grande'] }, after: { ...club, notified: ['cliente_grande'] } }), []);
});

test('pide_persona: normal, stop', () => {
  assert.deepEqual(only(decide({ turn: withSignals({ asks_human: true }) })), { reason: 'pide_persona', priority: 'normal', mode: 'stop' });
});

test('enojado: alta, stop', () => {
  assert.deepEqual(only(decide({ turn: withSignals({ angry: true }) })), { reason: 'enojado', priority: 'alta', mode: 'stop' });
});

test('empresa anterior: el texto del cliente con "elite" → normal, stop', () => {
  assert.deepEqual(only(decide({ customerText: 'Ustedes no son los de Elite?' })), { reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' });
  assert.deepEqual(decide({ customerText: 'quiero una cancha' }), []);
});

test('factura A: normal, flag, una sola vez', () => {
  for (const t of ['necesito factura A', 'FACTURA  A', 'me hacen factura A?', 'quiero factura a']) {
    assert.deepEqual(only(decide({ customerText: t })), { reason: 'factura_a', priority: 'normal', mode: 'flag' }, t);
  }
  // "factura a nombre de…" es la preposición, no la letra A
  for (const t of ['hacen factura a nombre de mi empresa?', 'la factura a mi nombre', 'sale factura C?']) assert.deepEqual(decide({ customerText: t }), [], t);
  assert.deepEqual(decide({ before: { ...emptyCard(), notified: ['factura_a'] }, customerText: 'factura A' }), []);
});

test('factura A (2.ª ronda): también "factura tipo A" y "facturan en A"; "factura a la empresa / un tercero / nuestro nombre" es la preposición', () => {
  for (const t of ['necesito factura tipo A', 'Factura Tipo a?', 'me facturan en A?', 'pueden facturar en a', 'FACTURAN EN A', 'factura A, la de empresas?']) {
    assert.deepEqual(only(decide({ customerText: t })), { reason: 'factura_a', priority: 'normal', mode: 'flag' }, t);
  }
  for (const t of ['factura a la empresa', 'la factura a el club', 'factura a los socios', 'factura a las dos empresas', 'factura a un tercero', 'factura a una sociedad', 'factura a nuestro nombre', 'factura a nuestra empresa', 'facturan en a nombre de mi socio']) {
    assert.deepEqual(decide({ customerText: t }), [], t);
  }
});

test('regateo: flag la 1.ª vez, stop la 2.ª', () => {
  const turn = withSignals({ negotiating: true });
  assert.deepEqual(only(decide({ after: flags(1, 0), turn })), { reason: 'regateo', priority: 'normal', mode: 'flag' });
  const first = flags(1, 0);
  assert.deepEqual(only(decide({ before: { ...first, notified: ['regateo'] }, after: { ...flags(2, 0), notified: ['regateo'] }, turn })), { reason: 'regateo', priority: 'normal', mode: 'stop' });
});

test('fuera_de_politica: solo aviso (flag), una sola vez, nunca frena al bot', () => {
  const turn = withSignals({ off_knowledge: true });
  assert.deepEqual(only(decide({ after: flags(0, 1), turn })), { reason: 'fuera_de_politica', priority: 'normal', mode: 'flag' });
  // la 2.ª, 3.ª… vez: ya avisado, no se repite y no hay stop
  assert.deepEqual(decide({ before: { ...flags(0, 1), notified: ['fuera_de_politica'] }, after: flags(0, 2), turn }), []);
  assert.deepEqual(decide({ before: { ...flags(0, 4), notified: ['fuera_de_politica'] }, after: flags(0, 5), turn }), []);
});

test('baja: prioridad baja, stop', () => {
  assert.deepEqual(only(decide({ turn: withSignals({ opt_out: true }) })), { reason: 'baja', priority: 'baja', mode: 'stop' });
});

test('no_es_cliente: prioridad normal (el equipo lo revisa por si era un cliente real), stop', () => {
  assert.deepEqual(only(decide({ turn: withSignals({ not_a_lead: true }) })), { reason: 'no_es_cliente', priority: 'normal', mode: 'stop' });
});

test('el handoff_request del modelo solo suma, siempre como aviso (flag)', () => {
  const turn = modelTurn({ handoff_request: { reason: 'fuera_de_politica', priority: 'alta' } });
  assert.deepEqual(only(decide({ turn })), { reason: 'fuera_de_politica', priority: 'alta', mode: 'flag' });
  // los avisos que el modelo sí puede pedir (los demás se ignoran: ver el test de abajo)
  for (const reason of ['cliente_grande', 'factura_a'] as const) {
    assert.deepEqual(only(decide({ turn: modelTurn({ handoff_request: { reason, priority: 'normal' } }) })), { reason, priority: 'normal', mode: 'flag' }, reason);
  }
  // no pisa lo que ya decidió el código ni repite un motivo
  const both = withSignals({ asks_human: true }, { handoff_request: { reason: 'pide_persona', priority: 'baja' } });
  assert.deepEqual(only(decide({ turn: both })), { reason: 'pide_persona', priority: 'normal', mode: 'stop' });
  // listo y falla del bot son solo del código
  assert.deepEqual(decide({ turn: modelTurn({ handoff_request: { reason: 'listo_para_presupuesto', priority: 'alta' } }) }), []);
  assert.deepEqual(decide({ turn: modelTurn({ handoff_request: { reason: 'falla_del_bot', priority: 'alta' } }) }), []);
  // y un aviso ya hecho no se repite
  assert.deepEqual(decide({ before: { ...emptyCard(), notified: ['fuera_de_politica'] }, turn }), []);
});

test('el handoff_request solo puede pedir avisos de tipo flag (cliente_grande, factura_a, fuera_de_politica); el resto se ignora', () => {
  for (const reason of ['pide_persona', 'enojado', 'pregunta_por_empresa_anterior', 'pide_verificacion', 'regateo'] as const) {
    assert.deepEqual(decide({ turn: modelTurn({ handoff_request: { reason, priority: 'alta' } }) }), [], reason);
  }
  // un pedido ignorado no queda "avisado": la señal real del turno siguiente sí frena
  const r1 = decide({ turn: modelTurn({ handoff_request: { reason: 'pide_persona', priority: 'baja' } }) });
  const before = { ...emptyCard(), notified: r1.map((h) => h.reason) };
  assert.deepEqual(only(decide({ before, turn: withSignals({ asks_human: true }) })), { reason: 'pide_persona', priority: 'normal', mode: 'stop' });
});

test('varios disparadores juntos salen en el orden de la tabla', () => {
  const after = { ...cardWith([], { cantidad_canchas: field('3', 'm1') }), flags: { negotiatingCount: 1, offKnowledgeCount: 0 } };
  const h = decide({ before: cardWith(['platea']), after, turn: withSignals({ negotiating: true, asks_human: true }), customerText: 'factura A' });
  assert.deepEqual(h.map((x) => x.reason), ['listo_para_presupuesto', 'cliente_grande', 'pide_persona', 'factura_a', 'regateo']);
});

test('empresa anterior: también con tilde, caracteres invisibles o letras cirílicas', () => {
  for (const t of ['Ustedes son los de Élite Padel?', 'son los de ELITE?', 'son los de El\u200Bite?', 'son los de \u0415l\u0456te?', 'ＥＬＩＴＥ?']) {
    assert.deepEqual(only(decide({ customerText: t })), { reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }, JSON.stringify(t));
  }
  assert.deepEqual(decide({ customerText: 'tienen señal de satélite?' }), []);
});

test('empresa anterior (2.ª ronda): del lado del cliente, "club de élite" (adjetivo) no frena; "son los de Elite?" y las variantes disfrazadas sí', () => {
  for (const t of ['queremos un club de élite', 'es para jugadores de elite', 'un nivel de elite', 'deportistas de elite', 'categoría de elite', 'calidad de ELITE']) {
    assert.deepEqual(decide({ customerText: t }), [], t);
  }
  for (const t of ['son los de Elite?', 'Ustedes son de Elite Padel?', 'son los de e_l_i_t_e?', 'son los de Εlιτε?', 'compré una cancha de Elite y nunca me la entregaron', 'tengo dos canchas de Élite a medio hacer', 'queremos un club de élite, pero son los de Elite?', 'son los de ᴇʟɪᴛᴇ?']) {
    assert.deepEqual(only(decide({ customerText: t })), { reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }, t);
  }
});

test('un stop ya avisado no se repite (salvo el regateo, que sube de aviso a stop)', () => {
  const before = { ...emptyCard(), notified: ['pide_persona', 'enojado', 'pregunta_por_empresa_anterior'] as LeadCard['notified'] };
  assert.deepEqual(decide({ before, turn: withSignals({ asks_human: true, angry: true }), customerText: 'Elite?' }), []);
});

test('opt_out y no_es_cliente descartan todas las otras derivaciones; no es cliente avisa con prioridad normal para que lo revisen', () => {
  const after = { ...cardWith([], { cantidad_canchas: field('3', 'm1') }), flags: { negotiatingCount: 1, offKnowledgeCount: 1 } };
  const rest = { negotiating: true, angry: true, asks_human: true, off_knowledge: true };
  const args = { before: cardWith(['platea']), after, customerText: 'factura A, son los de Elite?' };
  assert.deepEqual(decide({ ...args, turn: withSignals({ ...rest, opt_out: true }, { handoff_request: { reason: 'fuera_de_politica', priority: 'alta' } }) }), [{ reason: 'baja', priority: 'baja', mode: 'stop' }]);
  assert.deepEqual(decide({ ...args, turn: withSignals({ ...rest, not_a_lead: true }) }), [{ reason: 'no_es_cliente', priority: 'normal', mode: 'stop' }]);
  // el modelo no puede pedir estos motivos por handoff_request
  for (const reason of ['baja', 'no_es_cliente', 'listo_para_presupuesto', 'falla_del_bot'] as const) {
    assert.deepEqual(decide({ turn: modelTurn({ handoff_request: { reason, priority: 'alta' } }) }), [], reason);
  }
});

test('desconfía por segunda vez (taller, obras, antigüedad): pasa al equipo con prioridad alta; la primera vez, no (Lazar 7-oct)', () => {
  const turn = modelTurn({ objections: ['confianza'] });
  const duda = 'y tienen taller? quiero ver una obra';
  assert.deepEqual(decide({ turn, customerText: duda }), []);
  assert.deepEqual(decide({ before: { ...emptyCard(), objections: ['confianza'] }, turn, customerText: duda }), [{ reason: 'pide_verificacion', priority: 'alta', mode: 'stop' }]);
  assert.deepEqual(decide({ before: { ...emptyCard(), objections: ['confianza'] }, turn: modelTurn({ objections: ['precio'] }), customerText: duda }), []);
});

test('pide_verificacion (2.ª ronda): hace falta una señal de desconfianza en el texto nuevo del cliente; "ok y cuánto sale?" con objeciones precio+confianza no frena', () => {
  const before = { ...emptyCard(), objections: ['confianza' as const] };
  const turn = modelTurn({ objections: ['precio', 'confianza'] });
  assert.deepEqual(decide({ before, turn, customerText: 'ok y cuánto sale?' }), []);
  assert.deepEqual(decide({ before, turn, customerText: '' }), []);
  for (const t of [
    'tienen alguna obra para ver?', 'dónde queda el taller?', 'me pasan referencias?', 'no será una estafa?', 'no sé si confiar', 'cuánto hace que trabajan?',
    'qué antigüedad tienen?', 'tienen trayectoria?', 'existen realmente?', 'son reales las fotos?', 'puedo ver una cancha?', 'puedo ver alguna cancha?', 'quiero ver la cancha', 'cuál es la dirección?', 'Cuánto HACE que están',
  ]) {
    assert.deepEqual(only(decide({ before, turn, customerText: t })), { reason: 'pide_verificacion', priority: 'alta', mode: 'stop' }, t);
  }
  // el modelo tiene que repetir la objeción en este turno (la de antes no cuenta)
  assert.deepEqual(decide({ before, turn: modelTurn({ objections: ['precio'] }), customerText: 'dónde queda el taller?' }), []);
  // y tiene que estar ya en la ficha
  assert.deepEqual(decide({ turn, customerText: 'dónde queda el taller?' }), []);
});

test('pide_verificacion (3.ª ronda): señales con límite de palabra; "cobran", "confirmame" y "garantía" no son desconfianza', () => {
  const before = { ...emptyCard(), objections: ['confianza' as const] };
  const turn = modelTurn({ objections: ['confianza'] });
  for (const t of ['¿Cuánto cobran el flete?', '¿Me cobran IVA?', 'Confirmame el precio de la platea', 'Qué garantía tiene?', 'Cuánto cobran por la instalación, confirmame', 'Me confirman la fecha?']) {
    assert.deepEqual(decide({ before, turn, customerText: t }), [], t);
  }
  for (const t of ['¿Hace cuánto que trabajan?', '¿Tienen local? Puedo ir a conocerlos?', '¿Cuántos años tienen?', 'pasame la dirección del taller', 'puedo visitar el taller?', 'no sé si confío', 'tienen obras terminadas?']) {
    assert.deepEqual(only(decide({ before, turn, customerText: t })), { reason: 'pide_verificacion', priority: 'alta', mode: 'stop' }, t);
  }
});

test('empresa anterior (3.ª ronda): "nivel elite", "torneo de élite", "club elite" (con o sin "de") son adjetivo; "cancha de Elite" sigue siendo la empresa', () => {
  for (const t of [
    'Busco una cancha de nivel elite', 'es para un torneo de élite', 'somos un club elite', 'torneos elite', 'categoría elite', // "equipo de Elite" deriva: puede ser el equipo de la empresa anterior (un falso positivo solo pasa el chat al equipo)
    'quiero calidad elite', 'jugadores elite', 'deportistas de élite', 'clubes de elite', 'cancha de nivel de Elite',
  ]) {
    assert.deepEqual(decide({ customerText: t }), [], t);
  }
  for (const t of ['compré una cancha de Elite y nunca me la entregaron', 'son los de Elite?', 'el equipo de Elite nunca me terminó la cancha', 'tengo una cancha elite sin terminar', 'hablé con Elite hace un año']) {
    assert.deepEqual(only(decide({ customerText: t })), { reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }, t);
  }
});
