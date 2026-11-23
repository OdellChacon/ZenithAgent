/**
 * Detalles que hacen que el bot se sienta como una persona del equipo: escribe en mensajes
 * cortos y separados (como en un chat), con una pausa de "escribiendo" entre uno y otro,
 * sabe qué hora es en la tienda y conoce el nombre del cliente.
 */

/** Como mucho tantos mensajes por respuesta; lo que sobra va en el último. */
export const MAX_BUBBLES = 3;

/**
 * Parte la respuesta en mensajes por párrafo (línea en blanco), como escribe la gente en
 * WhatsApp. Las listas no se parten: si un párrafo empieza con viñeta, sigue en el mismo
 * mensaje que el anterior.
 */
export function splitBubbles(text: string, max = MAX_BUBBLES): string[] {
  const parts: string[] = [];
  for (const raw of text.split(/\n[ \t]*\n/)) {
    const part = raw.trim();
    if (!part) continue;
    const isListItem = /^(?:[-•]|\d+[.)])\s/.test(part);
    if (isListItem && parts.length) parts[parts.length - 1] += `\n\n${part}`;
    else parts.push(part);
  }
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join('\n\n')];
}

/** Pausa antes de un mensaje, como si alguien lo estuviera escribiendo (entre 0,8 y 3,5 s). */
export function typingPauseMs(text: string): number {
  return Math.min(3500, Math.max(800, Math.round(600 + text.length * 25)));
}

/** Primer nombre del perfil del cliente, solo letras; null si no parece un nombre. */
export function customerFirstName(profileName: string | null | undefined): string | null {
  const first = profileName?.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, '') ?? '';
  if (first.length < 2 || first.length > 20) return null;
  return first.charAt(0).toLocaleUpperCase('es') + first.slice(1).toLocaleLowerCase('es');
}

function localTime(now: Date, timezone: string): { label: string; hour: number } {
  const opts = { weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true } as const;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('es-VE', { ...opts, timeZone: timezone });
  } catch {
    fmt = new Intl.DateTimeFormat('es-VE', { ...opts, timeZone: 'UTC' });
  }
  const hourFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: fmt.resolvedOptions().timeZone });
  return { label: fmt.format(now), hour: Number(hourFmt.format(now)) };
}

/**
 * Nota con lo que una persona en la tienda sabría sin preguntar: la hora y el nombre con el que
 * aparece el cliente. Va al principio del historial; no es un mensaje del cliente.
 */
export function conversationNote(p: { customerName: string | null; now: Date; timezone: string }): string {
  const { label, hour } = localTime(p.now, p.timezone);
  const part = hour >= 5 && hour < 12 ? 'mañana' : hour >= 12 && hour < 19 ? 'tarde' : 'noche';
  const name = customerFirstName(p.customerName);
  return [
    `[Datos internos, no los escribió el cliente: en la tienda es ${label} (de ${part}).`,
    name
      ? `El cliente aparece en WhatsApp como "${name}"; puede llamarle por su nombre de vez en cuando, no en cada mensaje.]`
      : 'No se sabe el nombre del cliente; no se lo inventes.]',
  ].join(' ');
}
