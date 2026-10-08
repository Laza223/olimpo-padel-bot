// Las expectativas de un escenario contra lo que pasó en la conversación. Devuelve una lista de incumplimientos (vacía = cumple).
import type { LeadCard } from '../src/types.ts';
import { plain } from '../src/lead.ts';
import { compileRegex } from './scenario.ts';
import type { Expect } from './scenario.ts';
import type { TurnLog } from './types.ts';

const snippet = (s: string) => (s.length > 70 ? `${s.slice(0, 70)}...` : s);
const unique = <T>(xs: T[]) => [...new Set(xs)];

export function checkExpectations(e: Expect, turns: TurnLog[], card: LeadCard): string[] {
  const out: string[] = [];
  const bubbles = turns.flatMap((t) => t.bubbles);
  const seen = turns.filter((t) => t.turn >= (e.desde_turno ?? 1)).flatMap((t) => t.bubbles);
  const text = seen.join('\n');
  const where = e.desde_turno && e.desde_turno > 1 ? ` (desde el turno ${e.desde_turno})` : '';

  const handoffs = turns.map((t) => ({ turn: t.turn, reasons: t.handoffs.map((h) => h.reason) }));
  const given = unique(handoffs.flatMap((h) => h.reasons));
  const givenText = given.length ? `hubo ${given.join(', ')}` : 'no hubo ninguna';
  if (e.derivacion === 'ninguna') {
    if (given.length) out.push(`derivacion: se esperaba ninguna y ${givenText}`);
  } else if (e.derivacion) {
    for (const r of [e.derivacion].flat()) {
      const hit = handoffs.find((h) => h.reasons.includes(r));
      if (!hit) out.push(`derivacion: se esperaba ${r} y ${givenText}`);
      else if (e.derivacion_antes_del_turno !== undefined && hit.turn > e.derivacion_antes_del_turno) {
        out.push(`derivacion: ${r} llegó en el turno ${hit.turn} (máximo ${e.derivacion_antes_del_turno})`);
      }
    }
  }

  if (e.derivacion_alguna) {
    const any = e.derivacion_alguna;
    const hit = handoffs.find((h) => h.reasons.some((r) => any.includes(r)));
    if (!hit) out.push(`derivacion: se esperaba alguna de ${any.join(', ')} y ${givenText}`);
    else if (e.derivacion_antes_del_turno !== undefined && hit.turn > e.derivacion_antes_del_turno) {
      out.push(`derivacion: ${hit.reasons.find((r) => any.includes(r))} llegó en el turno ${hit.turn} (máximo ${e.derivacion_antes_del_turno})`);
    }
  }

  if (e.estado && card.state !== e.estado) out.push(`estado: se esperaba ${e.estado} y quedó ${card.state}`);

  for (const [field, want] of Object.entries(e.ficha ?? {})) {
    const got = card.fields[field as keyof LeadCard['fields']]?.value;
    if (got === undefined || plain(got).trim() !== plain(want).trim()) out.push(`ficha.${field}: se esperaba "${want}" y ${got === undefined ? 'quedó vacío' : `quedó "${got}"`}`);
  }

  for (const src of e.nunca_dice ?? []) {
    const m = compileRegex(src).exec(text);
    if (m) out.push(`nunca_dice${where}: el bot dijo "${snippet(m[0])}" (${src})`);
  }
  if (e.dice_alguna && !e.dice_alguna.some((src) => compileRegex(src).test(text))) {
    out.push(`dice_alguna${where}: el bot no dijo nada que coincida con ${e.dice_alguna.join(' | ')}`);
  }
  for (const src of e.dice_todas ?? []) {
    if (!compileRegex(src).test(text)) out.push(`dice_todas${where}: el bot no dijo nada que coincida con ${src}`);
  }

  if (e.primer_globo) {
    const first = bubbles[0];
    if (first === undefined) out.push('primer_globo: el bot no mandó ningún globo');
    else if (!compileRegex(e.primer_globo).test(first)) out.push(`primer_globo: "${snippet(first)}" no coincide con ${e.primer_globo}`);
  }
  if (e.sin_globos && bubbles.length) out.push(`sin_globos: el bot mandó ${bubbles.length} globo(s), el primero "${snippet(bubbles[0])}"`);

  const sent = new Set(turns.flatMap((t) => t.material));
  for (const id of e.material ?? []) if (!sent.has(id)) out.push(`material: no se mandó ${id} (se mandó ${[...sent].join(', ') || 'nada'})`);

  return out;
}
