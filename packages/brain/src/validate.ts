/**
 * Última barrera antes de enviar: el bot no tiene precios, así que cualquier monto en la
 * respuesta es inventado. También se cortan respuestas vacías o desmedidas.
 */
const MONEY_PATTERNS = [
  /(?:\$|US\$|USD|U\$S|€|EUR|Bs\.?S?|VES|COP)\s?\d/i,
  /\d[\d.,]*\s?(?:\$|USD|d[oó]lares?|bol[ií]vares?|euros?|Bs\b|pesos?)/i,
  /\bprecio\s+(?:es|de|:)\s*\d/i,
];

export const MAX_REPLY_CHARS = 1500;

export type ReplyCheck = { ok: true; text: string } | { ok: false; reason: 'empty' | 'mentions_price' | 'too_long' };

/**
 * ¿La respuesta le promete al cliente que un asesor lo atenderá? Si el modelo lo dice sin usar
 * derivar_a_asesor, nadie se entera: el sistema crea el pase igual. Solo compromisos ("le paso
 * su caso", "un asesor le escribirá"), no ofertas ("un asesor le puede confirmar").
 */
const HANDOFF_PROMISES = [
  /\ble\s+(?:paso|pasaré|pasar[ée]mos|voy\s+a\s+pasar|vamos\s+a\s+pasar|estoy\s+pasando|hago\s+llegar|voy\s+a\s+hacer\s+llegar)(?!\p{L})[^.?!\n]{0,80}\basesor/iu,
  /\b(?:paso|pasé|pasaré|voy\s+a\s+pasar)\s+(?:su|sus|el|la|los|las)\s+(?:caso|solicitud|datos|consulta|pedido|requerimiento)[^.?!\n]{0,40}\basesor/iu,
  // \b no sirve después de una letra con tilde: se usa (?!\p{L}).
  /\basesor(?:es)?\s+(?:de\s+\S+\s+)?le\s+(?:escribirá|escribe|va\s+a\s+escribir|estará\s+escribiendo|contactará|va\s+a\s+contactar|atenderá|va\s+a\s+atender|responderá|enviará|va\s+a\s+enviar|pasará|mandará|va\s+a\s+mandar)(?!\p{L})/iu,
];

export function promisesHandoff(text: string): boolean {
  // Las preguntas ("¿Le paso con un asesor?") son ofertas, no promesas.
  const sentences = text.split(/(?<=[.!?…])\s+|\n+/).filter((s) => !/^¿|\?\s*$/.test(s.trim()));
  return sentences.some((s) => HANDOFF_PROMISES.some((re) => re.test(s)));
}

export function checkReply(raw: string): ReplyCheck {
  const text = polishReply(raw.trim());
  if (!text) return { ok: false, reason: 'empty' };
  if (MONEY_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'mentions_price' };
  if (text.length > MAX_REPLY_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}

// ------------------------------------------------------------------ estilo

/** Inicio de frase: comienzo del texto, después de . ! ? o de un salto de línea. */
const START = String.raw`(^|[.!?…]\s+|\n\s*)`;

/** Muletillas de plantilla que el modelo usa al empezar aunque el prompt lo prohíba. */
const FILLER_OPENER = new RegExp(
  START +
    String.raw`¡?\s*(?:excelente|perfecto|genial|estupendo|fant[aá]stico|maravilloso|claro que s[ií]|por supuesto|` +
    String.raw`(?:qu[eé] |una )?(?:buena|excelente|gran|muy buena) (?:elecci[oó]n|pregunta|idea))\s*[!.,…]+[ \t]*`,
  'giu',
);

const GREETING_FILLER = new RegExp(START + String.raw`¡?\s*es un (?:gusto|placer) saludarl[eo]s?\s*[!.,]*[ \t]*`, 'giu');

const FILLER_CLOSER = /\s*¡?\s*que tenga (?:un |una )?(?:excelente|feliz|buen|lindo|bonito|bonita|linda) (?:d[ií]a|tarde|noche)\s*!*\s*$/iu;

/** Frases que narran lo que el bot hace por dentro; no aportan nada al cliente. */
const NARRATION_SENTENCE = new RegExp(
  START +
    String.raw`(?:ya\s+)?(?:he|hemos|acabo de|acabamos de)\s+(?:notificado|avisado|informado|enviado su solicitud|enviado la solicitud|registrado su solicitud)` +
    String.raw`\s+(?:a|al)\s+(?:nuestro|el)\s+equipo[^.!?\n]*[.!][ \t]*`,
  'giu',
);

const CATALOG_NARRATION = /\b(?:ya\s+)?(?:he|hemos|acabo de)\s+(?:revisado|consultado|buscado en)\s+(?:el|nuestro|mi)\s+(?:cat[aá]logo|inventario|sistema)\s*(?:y\s*,?\s*)?/giu;

/** "según el sistema", "el sistema calcula…": los datos se dicen como propios. */
const SYSTEM_ACCORDING = /\b(?:seg[uú]n|de acuerdo con)\s+(?:el|mi|nuestro)\s+(?:sistema|c[aá]lculo|calculadora|herramienta)\s*,?\s*/giu;
const SYSTEM_SAYS_THAT = /\b(?:el|mi|nuestro)\s+(?:sistema|calculadora|herramienta)\s+(?:me\s+)?(?:calcula|indica|muestra|arroja|dice|da)\s+que\s+/giu;
const SYSTEM_SAYS = /\b(?:el|mi|nuestro)\s+(?:sistema|calculadora|herramienta)\s+(?:me\s+)?(?:calcula|indica|muestra|arroja|da)\s+/giu;

const capitalizeSentences = (s: string) =>
  s.replace(/^(\s*[*¿¡"«]?)(\p{Ll})/u, (_, pre: string, ch: string) => pre + ch.toLocaleUpperCase('es'))
    .replace(/([.!?…]\s+|\n\s*)([*¿¡"«]?)(\p{Ll})/gu, (_, sep: string, pre: string, ch: string) => sep + pre + ch.toLocaleUpperCase('es'));

/**
 * Quita del mensaje las muletillas que el prompt ya prohíbe pero el modelo a veces usa:
 * "¡Excelente!" al empezar, "Es un gusto saludarle", "¡Que tenga un excelente día!" al cerrar,
 * y las frases que hablan del sistema o de lo que el bot hizo por dentro. Si quitar algo deja
 * el mensaje vacío, se conserva el original.
 */
export function polishReply(text: string): string {
  let out = text;
  // Dos pasadas: "¡Hola! Es un gusto saludarle. ¡Excelente elección!" encadena varias.
  for (let i = 0; i < 2; i++) {
    out = out.replace(GREETING_FILLER, '$1').replace(FILLER_OPENER, '$1').replace(NARRATION_SENTENCE, '$1');
  }
  out = out
    .replace(CATALOG_NARRATION, '')
    .replace(SYSTEM_ACCORDING, '')
    .replace(SYSTEM_SAYS_THAT, '')
    .replace(SYSTEM_SAYS, 'serían ')
    .replace(FILLER_CLOSER, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out === text) return text;
  out = capitalizeSentences(out);
  return out || text;
}
