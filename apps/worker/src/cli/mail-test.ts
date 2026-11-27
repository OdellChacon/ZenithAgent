/**
 * Prueba la configuración de correo (SMTP_*) mandando un correo de prueba, con el mismo código
 * que usan los avisos a los asesores. Sirve para confirmar el servidor de correo antes de
 * depender de los avisos.
 *
 *   npm run mail:test -- --to asesor@negocio.com
 *   (en el servidor) sh deploy/admin.sh mail-test --to asesor@negocio.com
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createSmtpMailer } from '../mailer.js';

const { values } = parseArgs({ options: { to: { type: 'string' } } });
const to = z.string().email().safeParse(values.to);
if (!to.success) {
  console.error('Uso: npm run mail:test -- --to correo@ejemplo.com');
  process.exit(1);
}

const env = z
  .object({
    SMTP_HOST: z.string().min(1, 'Falta SMTP_HOST'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(`Configuración de correo incompleta: ${env.error.issues.map((i) => i.message).join(', ')}`);
  process.exit(1);
}
const e = env.data;
const from = e.SMTP_FROM || e.SMTP_USER;
if (!from) {
  console.error('Falta SMTP_FROM (remitente de los avisos).');
  process.exit(1);
}

const mailer = createSmtpMailer({
  host: e.SMTP_HOST,
  port: e.SMTP_PORT,
  secure: e.SMTP_SECURE === 'true',
  ...(e.SMTP_USER ? { user: e.SMTP_USER } : {}),
  ...(e.SMTP_PASS ? { pass: e.SMTP_PASS } : {}),
  from,
});

try {
  await mailer.send({
    to: [to.data],
    subject: 'Prueba de avisos de ZenithAgent',
    text: 'Si recibes este correo, los avisos a los asesores (cliente que espera, WhatsApp desconectado) van a llegar.\n',
    html: '<p>Si recibes este correo, los avisos a los asesores (cliente que espera, WhatsApp desconectado) van a llegar.</p>',
  });
  console.log(`Correo de prueba enviado a ${to.data} por ${e.SMTP_HOST}:${e.SMTP_PORT}. Revisa también la carpeta de spam.`);
} catch (err) {
  // El mensaje del servidor de correo dice qué falló (usuario, contraseña, puerto, TLS…).
  console.error(`No se pudo enviar: ${(err as Error).message}`);
  process.exit(1);
}
