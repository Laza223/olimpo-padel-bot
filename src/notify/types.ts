// Avisos al equipo, vistos desde la tubería. La parte B los implementa con Telegram; las pruebas, con uno falso.
// Ningún método recibe ni muestra el teléfono: el equipo identifica cada chat por su número corto de conversación.
import type { HandoffDecision, LeadCard } from '../types.ts';

export interface AlertOpts {
  urgent?: boolean; // OpenAI sin saldo, sesión caída, envío con resultado incierto
}

export interface Notifier {
  // Aviso suelto: presupuesto, OpenAI sin saldo, adjunto que el bot no lee, envío incierto o restringido, tope de chats nuevos…
  alert(text: string, opts?: AlertOpts): void | Promise<void>;
  // Derivación: la ficha ya actualizada y las decisiones del turno (avisos y paradas). La ficha en texto se arma con buildFicha.
  handoff(chatId: string, card: LeadCard, decisions: HandoffDecision[]): void | Promise<void>;
  // Modo sombra: el borrador queda esperando [Mandar] / [Descartar] / [Lo tomo]. `material` son ids de policy/assets.yaml.
  draft(chatId: string, draftId: number, bubbles: string[], material: string[]): void | Promise<void>;
  // Alguien del equipo escribió desde el celular o la Web: el bot dejó el chat en `humano`.
  takeover(chatId: string): void | Promise<void>;
}
