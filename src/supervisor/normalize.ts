// Texto comparable: minúsculas, sin tildes ni caracteres invisibles, con las letras parecidas (cirílicas, griegas, ı, ł, versalitas) pasadas a latinas.
// Todo lo que se busca en el texto del cliente o del bot (empresa anterior, números, cierre) pasa primero por acá.
const INVISIBLE = /[​-‏‪-‮⁠-⁤­﻿]/g;
const CONFUSABLES: Record<string, string> = {
  // cirílicas
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l',
  // griegas (ya en minúscula: Ε Ι Τ pasan por toLowerCase), turca, polaca y versalitas
  ε: 'e', ι: 'i', τ: 't', ı: 'i', ł: 'l', ᴇ: 'e', ʟ: 'l', ɪ: 'i', ᴛ: 't',
};
const CONFUSABLES_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(CONFUSABLES_RE, (c) => CONFUSABLES[c])
    .replace(/×/g, 'x')
    .replace(/\s+/g, ' ');
}

// Solo letras y números separados por un espacio: para comparar frases sin importar mayúsculas, tildes ni puntuación.
export const words = (s: string): string => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// La empresa anterior, aunque venga con tilde, separadores ("E.L.I.T.E", "e_l_i_t_e"), caracteres invisibles o letras parecidas. "el ítem" no cuenta.
const ELITE = 'e[^a-z]*l[^a-z]*i[^a-z]*t[^a-z]*e(?!m)';
const ELITE_RE = new RegExp(`(?<![a-z])${ELITE}`);
// Lado del bot: absoluta, nunca se nombra.
export const mentionsElite = (s: string): boolean => ELITE_RE.test(fold(s));

// Lado del cliente: "un club de élite", "nivel elite", "torneo de élite" usan la palabra como adjetivo (con o sin "de") y no preguntan por la empresa.
// "cancha de Elite" y "el equipo de Elite" NO van acá: es el ex cliente de la empresa anterior (tiene que pasar al equipo).
const ELITE_ADJECTIVE = new RegExp(`\\b(?:nivel|torneo\\w*|clubs?|clubes|categoria|calidad|jugador\\w*|deportista\\w*)(?: de)? ${ELITE}`, 'g');
export const customerMentionsElite = (s: string): boolean => ELITE_RE.test(fold(s).replace(ELITE_ADJECTIVE, ' '));
