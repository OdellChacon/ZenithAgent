import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';

/**
 * Estado vacío con ícono ilustrado: un mosaico con brillo, anillos que respiran y el ícono que
 * entra con un pequeño rebote. `size="lg"` es para el panel central.
 */
export function EmptyState({
  icon: I,
  title,
  text,
  tone = 'muted',
  size = 'sm',
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
  tone?: 'ok' | 'muted' | 'accent';
  size?: 'sm' | 'lg';
}) {
  return (
    <motion.div
      className={`empty-state ${size} tone-${tone}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
    >
      <span className="empty-art" aria-hidden="true">
        <i className="ring r1" />
        <i className="ring r2" />
        <motion.span
          className="empty-glyph"
          initial={{ scale: 0.6, rotate: -12 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 14, delay: 0.05 }}
        >
          <I strokeWidth={1.7} />
        </motion.span>
      </span>
      <b>{title}</b>
      {text && <p>{text}</p>}
    </motion.div>
  );
}
