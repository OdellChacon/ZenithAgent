import type React from 'react';
import { motion } from 'motion/react';
import { Check, Lock } from 'lucide-react';
import { ChannelBadge } from './ui';

type Step = { text: string; state: 'done' | 'todo' | 'blocked' };

interface ChannelPlan {
  name: string;
  channel: string;
  glow: string;
  /** Avance estimado del canal completo (código + puesta en marcha). */
  progress: number;
  intro: string;
  steps: Step[];
}

const PLANS: Record<'facebook' | 'instagram' | 'tiktok', ChannelPlan> = {
  facebook: {
    name: 'Facebook Messenger',
    channel: 'facebook',
    glow: 'var(--fb)',
    progress: 35,
    intro: 'Los mensajes de la página de Facebook llegarán a esta misma bandeja y el bot los atenderá igual que en WhatsApp.',
    steps: [
      { text: 'Bot, catálogo, pase a asesor y panel (compartidos con WhatsApp)', state: 'done' },
      { text: 'Reglas de la ventana de 24 h y respuesta manual hasta 7 días (Human Agent)', state: 'done' },
      { text: 'Conector de Messenger: recibir y enviar mensajes', state: 'todo' },
      { text: 'Conectar la página de Facebook desde este panel', state: 'todo' },
      { text: 'Responder a un comentario con un mensaje privado', state: 'todo' },
      { text: 'Aprobación de la app por Meta (App Review)', state: 'blocked' },
    ],
  },
  instagram: {
    name: 'Instagram',
    channel: 'instagram',
    glow: 'var(--ig-b)',
    progress: 35,
    intro: 'Los mensajes directos de Instagram llegarán a esta bandeja. Hace falta una cuenta profesional vinculada a la página de Facebook.',
    steps: [
      { text: 'Bot, catálogo, pase a asesor y panel (compartidos con WhatsApp)', state: 'done' },
      { text: 'Reglas de la ventana de 24 h y respuesta manual hasta 7 días (Human Agent)', state: 'done' },
      { text: 'Conector de Instagram: mensajes directos, fotos y respuestas a historias', state: 'todo' },
      { text: 'Conectar la cuenta de Instagram desde este panel', state: 'todo' },
      { text: 'Responder a un comentario con un mensaje directo', state: 'todo' },
      { text: 'Aprobación de la app por Meta (App Review)', state: 'blocked' },
    ],
  },
  tiktok: {
    name: 'TikTok',
    channel: 'tiktok',
    glow: 'var(--tt-b)',
    progress: 20,
    intro: 'La mensajería de TikTok para empresas es de acceso restringido. Primero hay que conseguir el acceso; sin eso no hay fecha.',
    steps: [
      { text: 'Bot, catálogo, pase a asesor y panel (compartidos con WhatsApp)', state: 'done' },
      { text: 'Decidir la vía de acceso: directo con TikTok o con un socio aprobado', state: 'todo' },
      { text: 'Confirmar las reglas de envío fuera de las 24 h', state: 'todo' },
      { text: 'Conector de TikTok y conexión de la cuenta desde este panel', state: 'todo' },
      { text: 'Acceso a la API de mensajería de TikTok', state: 'blocked' },
    ],
  },
};

const MARK: Record<Step['state'], React.ReactNode> = {
  done: <Check strokeWidth={3} />,
  todo: null,
  blocked: <Lock strokeWidth={2.4} />,
};

export function ComingSoon({ which }: { which: keyof typeof PLANS }) {
  const p = PLANS[which];
  return (
    <div className="soon">
      <motion.section
        className="card soon-card"
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        aria-labelledby="soon-title"
      >
        <span className="soon-glow" style={{ background: p.glow }} aria-hidden="true" />
        <motion.div initial={{ rotate: -14, scale: 0.6 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 14, delay: 0.08 }}>
          <ChannelBadge channel={p.channel} large />
        </motion.div>
        <span className="chip warn-chip">En construcción</span>
        <h2 id="soon-title">{p.name}</h2>
        <p className="muted">{p.intro}</p>

        <div className="soon-progress">
          <div className="item-top small">
            <b>Avance estimado</b>
            <span className="muted">{p.progress}%</span>
          </div>
          <div className="bar" role="progressbar" aria-valuenow={p.progress} aria-valuemin={0} aria-valuemax={100}>
            <motion.i
              style={{ background: p.glow }}
              initial={{ width: 0 }}
              animate={{ width: `${p.progress}%` }}
              transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.25 }}
            />
          </div>
        </div>

        <ol className="soon-steps">
          {p.steps.map((s, i) => (
            <motion.li
              key={s.text}
              className={s.state}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + i * 0.06, type: 'spring', stiffness: 320, damping: 28 }}
            >
              <i aria-hidden="true">{MARK[s.state]}</i>
              <span>
                {s.text}
                {s.state === 'blocked' && <span className="muted"> · depende de un tercero</span>}
                {s.state === 'done' && <span className="muted"> · listo</span>}
              </span>
            </motion.li>
          ))}
        </ol>
      </motion.section>
    </div>
  );
}
