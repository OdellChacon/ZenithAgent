import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './ui';

/**
 * Ventana modal del panel: fondo oscurecido, se cierra con Esc, con la X o tocando fuera
 * (salvo mientras `busy`), mantiene el foco adentro y lo devuelve al cerrar.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  busy = false,
  size = 'md',
  tone,
  bare = false,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Mientras se guarda: no se cierra por accidente. */
  busy?: boolean;
  size?: 'sm' | 'md';
  tone?: 'danger';
  /** Sin cabecera: el contenido trae su propio título (con id="modal-title"). */
  bare?: boolean;
  /** Selector del elemento que recibe el foco al abrir (por defecto, el primer campo o botón). */
  initialFocus?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      [...(box.current?.querySelectorAll<HTMLElement>('input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])') ?? [])].filter(
        (el) => !el.hasAttribute('disabled') && !el.closest('.modal-x'),
      );
    requestAnimationFrame(() => {
      const first = (initialFocus && box.current?.querySelector<HTMLElement>(initialFocus)) || focusables()[0];
      first?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && box.current) {
        const all = [...box.current.querySelectorAll<HTMLElement>('input, textarea, select, button, a[href]')].filter((el) => !el.hasAttribute('disabled'));
        if (!all.length) return;
        const first = all[0]!;
        const last = all[all.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, initialFocus]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="modal-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="modal-backdrop" onClick={() => !busy && onClose()} />
          <motion.div
            ref={box}
            className={`modal modal-${size} ${tone ? `modal-${tone}` : ''} ${bare ? 'modal-bare' : ''}`}
            role={tone === 'danger' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="modal-title"
            initial={{ y: 14, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 14, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 460, damping: 36 }}
          >
            {bare ? (
              <button className="icon-btn modal-x modal-x-float" type="button" onClick={onClose} disabled={busy} aria-label="Cerrar">
                {Icon.close}
              </button>
            ) : (
              <header className="modal-head">
                <div>
                  <h2 id="modal-title">{title}</h2>
                  {description && <div className="muted small modal-desc">{description}</div>}
                </div>
                <button className="icon-btn modal-x" type="button" onClick={onClose} disabled={busy} aria-label="Cerrar">
                  {Icon.close}
                </button>
              </header>
            )}
            {children && <div className="modal-body">{children}</div>}
            {footer && <footer className="modal-foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Una consecuencia de la acción: lo que se pierde o lo que se conserva. */
export interface Consequence {
  kind: 'lose' | 'keep';
  text: ReactNode;
}

/**
 * Confirmación de una acción que no se puede deshacer (quitar, borrar…): ícono de alerta, qué
 * se va a quitar, qué se pierde y qué se conserva. El foco empieza en "Cancelar" para que un
 * Enter por accidente no borre nada; si falla, el modal tiembla y dice por qué.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  item,
  consequences = [],
  confirmLabel,
  busyLabel = 'Un momento…',
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: ReactNode;
  /** Lo que se va a quitar, tal como lo ve el usuario. */
  item?: ReactNode;
  consequences?: Consequence[];
  confirmLabel: string;
  busyLabel?: string;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} busy={busy} size="sm" tone="danger" bare initialFocus=".modal-cancel">
      <motion.div
        className="confirm"
        key={error ?? 'ok'}
        animate={error ? { x: [0, -8, 8, -5, 5, 0] } : { x: 0 }}
        transition={{ duration: 0.36 }}
      >
        <div className="confirm-hero" aria-hidden="true">
          <span className="confirm-ring" />
          <span className="confirm-icon">{Icon.trash}</span>
        </div>
        <h2 id="modal-title">{title}</h2>
        {message && <p className="confirm-text">{message}</p>}
        {item && <div className="confirm-item">{item}</div>}
        {consequences.length > 0 && (
          <ul className="confirm-list">
            {consequences.map((c, i) => (
              <li key={i} className={c.kind}>
                <span className="confirm-mark" aria-hidden="true">
                  {c.kind === 'keep' ? Icon.check : Icon.close}
                </span>
                <span>
                  <span className="sr-only">{c.kind === 'keep' ? 'Se conserva: ' : 'Se pierde: '}</span>
                  {c.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="confirm-error" role="alert">
            {Icon.alert} {error}
          </p>
        )}
        <div className="confirm-actions">
          <button className="btn modal-cancel" type="button" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button className="btn danger-btn confirm-go" type="button" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : Icon.trash}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </motion.div>
    </Modal>
  );
}
