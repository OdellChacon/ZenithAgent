import { z } from 'zod';

/**
 * Lo que el bot sabe del negocio. Vive en `tenants.settings.business` y lo edita el
 * administrador. Lo que falta queda en null: el bot no lo inventa, deriva a un asesor.
 */
const nullableText = z.string().trim().min(1).nullish().transform((v) => v ?? null);

export const businessProfileSchema = z.object({
  name: z.string().trim().min(1),
  description: nullableText,
  address: nullableText,
  phones: z.array(z.string().trim().min(1)).default([]),
  email: nullableText,
  instagram: nullableText,
  website: nullableText,
  hours: nullableText,
  paymentMethods: nullableText,
  delivery: nullableText,
  specialOrders: nullableText,
  visualizer: z
    .object({ name: z.string().trim().min(1), description: z.string().trim().min(1), url: nullableText })
    .nullish()
    .transform((v) => v ?? null),
  /** Datos extra que el negocio quiera que el bot sepa (políticas, garantías…). */
  notes: z.array(z.string().trim().min(1)).default([]),
});

/**
 * Plantilla de WhatsApp aprobada por Meta para escribir fuera de las 24 h. El texto lo guarda
 * Meta; `preview` es una copia para el historial y el panel, con {{1}}, {{2}}… donde van los
 * parámetros. Los parámetros admiten {nombre} (primer nombre del cliente) y {negocio}.
 */
export const followupTemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'nombre de plantilla inválido (minúsculas, números y _)'),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'idioma inválido (ej. es, es_MX)'),
  preview: z.string().trim().min(1).max(1024),
  params: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  /** Para {nombre} cuando WhatsApp no trae el nombre del cliente. */
  nameFallback: z.string().trim().min(1).max(60).default('estimado cliente'),
  /** Minutos desde el último mensaje del cliente. */
  afterMinutes: z.number().int().min(1).max(30 * 24 * 60).default(48 * 60),
});

/**
 * Seguimiento a clientes que dejan de responder. Paso 1: el bot escribe un mensaje propio
 * mientras la ventana de 24 h sigue abierta. Paso 2: plantilla aprobada, ya fuera de las 24 h.
 */
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Hora en formato HH:MM');
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Un tramo del horario: días (0 = domingo … 6 = sábado) y horas, en la zona horaria del negocio. */
export const sendWindowSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    from: clock,
    to: clock,
  })
  .refine((w) => toMinutes(w.from) < toMinutes(w.to), 'La hora de inicio debe ser anterior a la de cierre');

/**
 * Seguimiento a clientes que dejan de responder. Paso 1: el bot escribe un mensaje propio
 * mientras la ventana de 24 h sigue abierta. Paso 2: plantilla aprobada, ya fuera de las 24 h.
 * El bot responde a cualquier hora; los seguimientos, en cambio, solo salen en `sendHours`.
 */
export const followupSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Minutos de silencio desde la última respuesta del bot (momento ideal del paso 1). */
  firstAfterMinutes: z.number().int().min(1).max(23 * 60).default(20 * 60),
  /**
   * Si el momento ideal cae fuera de horario o después de que cierre la ventana de 24 h, el
   * paso 1 se adelanta al último tramo de horario disponible, pero nunca antes de este silencio.
   */
  minFirstAfterMinutes: z.number().int().min(1).max(23 * 60).default(3 * 60),
  template: followupTemplateSchema.nullish().transform((v) => v ?? null),
  /** Cuándo se pueden enviar seguimientos (hora local del negocio). Por defecto, lunes a sábado de 8:00 a 18:00. */
  sendHours: z
    .array(sendWindowSchema)
    .min(1)
    .max(14)
    .default([{ days: [1, 2, 3, 4, 5, 6], from: '08:00', to: '18:00' }]),
  /** Conversaciones más viejas que esto no se retoman solas. */
  maxAgeDays: z.number().int().min(1).max(60).default(14),
});

export type FollowupSettings = z.infer<typeof followupSettingsSchema>;
export type FollowupTemplate = z.infer<typeof followupTemplateSchema>;
export type SendWindow = z.infer<typeof sendWindowSchema>;

export const tenantBotSettingsSchema = z.object({
  business: businessProfileSchema,
  boxes: z
    .object({
      /** % de desperdicio para calcular cajas. null = sin dato (el asesor lo confirma). */
      wastePercent: z.number().min(0).max(50).nullish().transform((v) => v ?? null),
    })
    .default({ wastePercent: null }),
  // prefault: el objeto vacío pasa por el esquema y toma los valores por defecto.
  followups: followupSettingsSchema.prefault({}),
});

export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export type TenantBotSettings = z.infer<typeof tenantBotSettingsSchema>;

export class TenantSettingsError extends Error {
  override name = 'TenantSettingsError';
}

export function parseTenantBotSettings(settings: unknown): TenantBotSettings {
  const parsed = tenantBotSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw new TenantSettingsError(
      `Configuración del bot incompleta: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return parsed.data;
}
