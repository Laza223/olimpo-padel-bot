// HTML que escapa por defecto: todo valor interpolado se limpia (caracteres de control y de dirección) y se escapa,
// salvo lo que ya es HTML armado con esta misma plantilla (Html). Lo que escribe un cliente nunca llega crudo al navegador.
import { clean } from '../notify/telegram.ts';

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s: string): string => clean(s).replace(/[&<>"'`]/g, (c) => ESC[c]);

type Value = Html | string | number | boolean | null | undefined | readonly Value[];
const render = (v: Value): string => {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(String(v));
};

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

// Solo para HTML que no viene de nadie de afuera (un literal del código). Marcarlo a mano obliga a pensarlo.
export const trusted = (s: string): Html => new Html(s);
