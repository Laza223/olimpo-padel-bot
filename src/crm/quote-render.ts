// HTML del presupuesto → PDF con Chromium sin ventana (en la imagen del bot; en la notebook, el Chrome instalado). Reemplaza al printToPDF de Electron.
// Probado el 10-oct (LEDGER, corte 2): la línea de comandos espera la fuente de Google antes de imprimir; sin red cae a la Inter instalada (Docker) o a Arial.
// Una corrida por vez (Chromium pesa), con tope de tiempo, en una carpeta temporal propia que se borra siempre.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RENDER_TIMEOUT_MS = 30_000;

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

export type RenderPdf = (html: string) => Promise<Buffer>;

// `run` es inyectable para las pruebas (un Chromium falso); por defecto, execFile.
export function createPdfRenderer(o: { chromiumPath: string | undefined; timeoutMs?: number; run?: (cmd: string, args: string[], timeoutMs: number) => Promise<void> }): RenderPdf {
  const run = o.run ?? ((cmd, args, timeout) => new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err) => (err ? reject(err) : resolve()));
  }));
  let queue: Promise<unknown> = Promise.resolve();

  async function once(html: string): Promise<Buffer> {
    if (!o.chromiumPath) throw new RenderError('Falta CHROMIUM_PATH: no hay con qué armar el PDF.');
    const dir = await mkdtemp(join(tmpdir(), 'olimpo-pdf-'));
    try {
      const page = join(dir, 'presupuesto.html');
      const out = join(dir, 'presupuesto.pdf');
      await writeFile(page, html, 'utf8');
      await run(o.chromiumPath, [
        '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--no-pdf-header-footer', `--user-data-dir=${join(dir, 'perfil')}`, `--print-to-pdf=${out}`, pathToFileURL(page).href,
      ], o.timeoutMs ?? RENDER_TIMEOUT_MS).catch((e: unknown) => {
        throw new RenderError(`Chromium falló: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      });
      const pdf = await readFile(out).catch(() => {
        throw new RenderError('Chromium no dejó el PDF.');
      });
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new RenderError('Chromium dejó un archivo que no es un PDF.');
      return pdf;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return (html) => {
    const p = queue.then(() => once(html));
    queue = p.catch(() => undefined);
    return p;
  };
}
