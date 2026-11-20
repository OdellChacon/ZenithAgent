/** Avisos en el navegador: sonido, notificación del sistema y contador en el título. */

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

/** Dos tonos cortos, generados en el navegador (sin archivos de audio). */
export function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.18);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* sin audio: el aviso visual basta */
  }
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
