import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argentinaHour, argentinaClock, greetingFor, argentinaTimeToUtcMs } from '../src/time.ts';

// Hora argentina (UTC-3) hh:mm del 7-oct-2026 → ms UTC.
const ar = (hh: number, mm: number) => Date.UTC(2026, 9, 7, hh + 3, mm);

function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const bordes: [number, number, string][] = [
  [5, 59, 'Buenas noches'],
  [6, 0, 'Buen día'],
  [12, 59, 'Buen día'],
  [13, 0, 'Buenas tardes'],
  [19, 59, 'Buenas tardes'],
  [20, 0, 'Buenas noches'],
  [0, 0, 'Buenas noches'],
  [23, 59, 'Buenas noches'],
];

for (const tz of [undefined, 'Asia/Tokyo', 'Pacific/Auckland', 'America/Los_Angeles']) {
  test(`greetingFor en los bordes (TZ del proceso: ${tz ?? 'la de la PC'})`, () => {
    const run = () => {
      for (const [h, m, expected] of bordes) {
        assert.equal(greetingFor(ar(h, m)), expected, `${h}:${m}`);
        assert.equal(argentinaHour(ar(h, m)), h);
      }
    };
    if (tz) withTZ(tz, run);
    else run();
  });
}

test('la zona del proceso realmente cambia (si no, la prueba de arriba no probaría nada)', () => {
  const t = ar(12, 59);
  const local = withTZ('Pacific/Auckland', () => new Date(t).getHours());
  assert.notEqual(local, 12);
});

test('argentinaClock da HH:MM con cero a la izquierda y medianoche como 00', () => {
  assert.equal(argentinaClock(ar(0, 5)), '00:05');
  assert.equal(argentinaClock(ar(14, 3)), '14:03');
});

test('argentinaTimeToUtcMs fija la hora argentina del día de la base', () => {
  const base = ar(10, 0);
  assert.equal(argentinaClock(argentinaTimeToUtcMs('22:30', base)), '22:30');
  assert.equal(argentinaTimeToUtcMs('22:30', base), ar(22, 30));
  assert.equal(greetingFor(argentinaTimeToUtcMs('23:00', base)), 'Buenas noches');
  assert.equal(greetingFor(argentinaTimeToUtcMs('9:15', base)), 'Buen día');
  assert.throws(() => argentinaTimeToUtcMs('25:00'), /hora inválida/);
  assert.throws(() => argentinaTimeToUtcMs('tarde'), /hora inválida/);
});
