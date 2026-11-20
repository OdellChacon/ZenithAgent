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

export const tenantBotSettingsSchema = z.object({
  business: businessProfileSchema,
  boxes: z
    .object({
      /** % de desperdicio para calcular cajas. null = sin dato (el asesor lo confirma). */
      wastePercent: z.number().min(0).max(50).nullish().transform((v) => v ?? null),
    })
    .default({ wastePercent: null }),
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
