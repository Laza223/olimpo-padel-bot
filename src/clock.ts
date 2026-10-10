// Reloj inyectable: la hora y los timers pasan por acá para que las pruebas los manejen sin esperar de verdad.
export interface Clock {
  now(): number; // ms UTC
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

