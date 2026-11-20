import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  META_APP_SECRET: z.string().min(1, 'Define META_APP_SECRET'),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16, 'META_WEBHOOK_VERIFY_TOKEN debe tener al menos 16 caracteres'),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type GatewayConfig = z.infer<typeof schema>;

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración del gateway inválida:\n${issues}`);
  }
  return parsed.data;
}
