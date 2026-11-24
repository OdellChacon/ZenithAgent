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

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Día de la semana (0 = domingo) y minuto del día en la zona horaria del negocio. */
function storeClock(at: Date, timezone: string): { day: number; minute: number } {
  const opts = { weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' } as const;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: WEEKDAYS[parts.weekday!] ?? 0, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** "8:00 a. m.", "1:00 p. m.", "12:30 p. m." */
function clockLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const suffix = h < 12 ? 'a. m.' : 'p. m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export interface OpeningWindow {
  days: number[];
  from: string;
  to: string;
}

/**
 * ¿La tienda está abierta ahora? Si está abierta, a qué hora cierra; si no, cuándo abre
 * (hoy, mañana o el día de la semana). null si el negocio no cargó su horario.
 */
export function storeStatus(
  now: Date,
  timezone: string,
  hours: readonly OpeningWindow[],
): { open: true; closesAt: string } | { open: false; opensAt: string } | null {
  if (!hours.length) return null;
  const { day, minute } = storeClock(now, timezone);
  const current = hours.find((w) => w.days.includes(day) && minute >= toMinutes(w.from) && minute < toMinutes(w.to));
  if (current) return { open: true, closesAt: clockLabel(toMinutes(current.to)) };
  for (let offset = 0; offset <= 7; offset++) {
    const d = (day + offset) % 7;
    const starts = hours
      .filter((w) => w.days.includes(d))
      .map((w) => toMinutes(w.from))
      .filter((m) => offset > 0 || m > minute)
      .sort((a, b) => a - b);
    if (!starts.length) continue;
    const when = offset === 0 ? 'hoy' : offset === 1 ? 'mañana' : `el ${DAY_NAMES[d]}`;
    return { open: false, opensAt: `${when} a las ${clockLabel(starts[0]!)}` };
  }
  return null;
}

/**
 * Nota con lo que una persona en la tienda sabría sin preguntar: la hora y el nombre con el que
 * aparece el cliente. Va al principio del historial; no es un mensaje del cliente.
 */
export function conversationNote(p: {
  customerName: string | null;
  now: Date;
  timezone: string;
  openingHours?: readonly OpeningWindow[];
}): string {
  const { label, hour } = localTime(p.now, p.timezone);
  const part = hour >= 5 && hour < 12 ? 'mañana' : hour >= 12 && hour < 19 ? 'tarde' : 'noche';
  const name = customerFirstName(p.customerName);
  const status = storeStatus(p.now, p.timezone, p.openingHours ?? []);
  const store = !status
    ? ''
    : status.open
      ? ` La tienda está abierta (cierra a las ${status.closesAt}).`
      : ` La tienda está cerrada: abre ${status.opensAt}.`;
  return [
    `[Datos internos, no los escribió el cliente: en la tienda es ${label} (de ${part}).${store}`,
    name
      ? `El cliente aparece en WhatsApp como "${name}"; puede llamarle por su nombre de vez en cuando, no en cada mensaje.]`
      : 'No se sabe el nombre del cliente; no se lo inventes.]',
  ].join(' ');
}
