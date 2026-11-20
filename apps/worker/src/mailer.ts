import nodemailer from 'nodemailer';
import type { Mailer } from './notify.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}),
  });
  return {
    async send(message) {
      await transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
    },
  };
}

/** Sin SMTP configurado: el aviso queda en el log (útil en desarrollo). */
export function createLogMailer(log: (msg: string, data: object) => void): Mailer {
  return {
    async send(message) {
      log('Aviso por correo (SMTP no configurado, no se envió)', { to: message.to.length, subject: message.subject });
    },
  };
}
