/** Avisos en el navegador: sonido, notificación del sistema y contador en el título. */
import { playSound } from './sounds';

const BASE_TITLE = 'Panel de asesores';
let unseen = 0;

export function setUnseen(count: number) {
  unseen = Math.max(0, count);
  document.title = unseen ? `(${unseen}) ${BASE_TITLE}` : BASE_TITLE;
}

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationsEnabled() {
  return notificationsSupported() && Notification.permission === 'granted';
}

export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** Sonido del aviso de pase (también sirve para probar que el audio funciona). */
export function chime() {
  playSound('handoff');
}

export function alertHandoff(onClick: () => void) {
  chime();
  setUnseen(unseen + 1);
  if (notificationsEnabled() && document.visibilityState !== 'visible') {
    const n = new Notification('Un cliente espera a un asesor', { body: 'Abre el panel para atenderlo.', tag: 'zenith-handoff' });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  }
}
