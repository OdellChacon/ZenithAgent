/**
 * Tema claro u oscuro. Sin elección guardada se sigue al sistema operativo; la elección del
 * asesor se guarda en este navegador y se aplica como data-theme en <html>.
 */
import { flushSync } from 'react-dom';

export type Theme = 'light' | 'dark';
const KEY = 'zenith.panel.theme';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme | undefined) ?? stored() ?? systemTheme();
}

/** Se llama antes de pintar para que no haya un parpadeo del tema equivocado. */
export function initTheme() {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
}

/**
 * Cambia el tema con un círculo que se expande desde el botón (View Transitions API).
 * `update` actualiza el estado de React dentro de la transición.
 */
export function setTheme(next: Theme, origin: { x: number; y: number } | null, update: () => void) {
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* sin almacenamiento: vale para esta pestaña */
    }
    flushSync(update);
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!doc.startViewTransition || !origin || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
    return;
  }
  const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
  document.documentElement.classList.add('theme-switch');
  const vt = doc.startViewTransition(apply);
  vt.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => undefined);
  setTimeout(() => document.documentElement.classList.remove('theme-switch'), 700);
}
