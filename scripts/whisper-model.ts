// Baja el modelo de Whisper (ggml-small.bin, unos 465 MB) a whisper-models/ si todavía no está. Sin dependencias: fetch de Node.
// Uso: pnpm whisper:model   (lo usa el contenedor `whisper` de docker-compose.yml; ver docs/operacion.md)
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';

const FILE = 'ggml-small.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${FILE}`;
const SIZE = 487_601_967; // bytes
const SHA256 = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'; // el mismo que publica Hugging Face (X-Linked-ETag)

const dir = join(import.meta.dirname, '..', 'whisper-models');
const target = join(dir, FILE);
const part = `${target}.part`;
const mb = (n: number) => (n / 1048576).toFixed(0);

// Ya está y es el archivo completo: no se baja de nuevo (el tamaño alcanza para detectar uno cortado).
const size = await stat(target).then((s) => s.size, () => -1);
if (size === SIZE) {
  console.log(`${FILE} ya está en whisper-models/ (${mb(SIZE)} MB). No hay nada que bajar.`);
  process.exit(0);
}
if (size >= 0) console.log(`${FILE} está incompleto o es otro archivo (${size} bytes): se baja de nuevo.`);

await mkdir(dir, { recursive: true });
console.log(`Bajando ${FILE} (${mb(SIZE)} MB) de Hugging Face...`);
try {
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Hugging Face contestó ${res.status}`);
  const hash = createHash('sha256');
  const t0 = Date.now();
  let got = 0;
  let lastPrint = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      hash.update(chunk);
      if (Date.now() - lastPrint > 500) {
        lastPrint = Date.now();
        process.stdout.write(`\r  ${mb(got)} / ${mb(SIZE)} MB (${Math.min(100, Math.round((got / SIZE) * 100))} %), ${(got / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s   `);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as WebStream), progress, createWriteStream(part));
  process.stdout.write('\n');
  if (got !== SIZE || hash.digest('hex') !== SHA256) throw new Error('el archivo bajado no es el esperado (tamaño o firma distintos)');
  await rename(part, target);
  console.log(`Listo: whisper-models/${FILE}. Ahora: docker compose up -d`);
} catch (e) {
  await rm(part, { force: true });
  console.error(`\nNo se pudo bajar el modelo: ${e instanceof Error ? e.message : String(e)}. Revisá la conexión y corré pnpm whisper:model de nuevo.`);
  process.exit(1);
}
