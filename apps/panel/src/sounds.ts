/**
 * Sonidos del panel, sintetizados en el navegador con Web Audio (sin archivos que descargar).
 * El navegador solo deja sonar audio después de un clic o una tecla: el contexto se crea y se
 * reanuda en el primer gesto del usuario.
 */

export type SoundName = 'handoff' | 'incoming' | 'sent' | 'tap' | 'success';

const MUTE_KEY = 'zenith.panel.muted';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = readMuted();
const listeners = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(next: boolean) {
  muted = next;
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    /* sin almacenamiento: dura lo que dure la pestaña */
  }
  listeners.forEach((fn) => fn(next));
}

export function onMutedChange(fn: (muted: boolean) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function audio(): { ctx: AudioContext; out: GainNode } | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.55;
      // Un compresor suave evita que dos avisos seguidos saturen.
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return { ctx, out: master! };
  } catch {
    return null;
  }
}

/** Prepara el audio en el primer gesto para que el primer aviso no llegue mudo. */
export function unlockAudioOnGesture() {
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

interface Note {
  freq: number;
  at: number;
  dur: number;
  gain?: number;
  type?: OscillatorType;
  /** Frecuencia final para un barrido. */
  to?: number;
}

function play(notes: Note[]) {
  const a = audio();
  if (!a) return;
  const t0 = a.ctx.currentTime + 0.01;
  for (const n of notes) {
    const osc = a.ctx.createOscillator();
    const env = a.ctx.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.setValueAtTime(n.freq, t0 + n.at);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, t0 + n.at + n.dur);
    const peak = n.gain ?? 0.25;
    env.gain.setValueAtTime(0.0001, t0 + n.at);
    env.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(env).connect(a.out);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
}

const SOUNDS: Record<SoundName, Note[]> = {
  // Cliente esperando asesor: arpegio ascendente, claro y reconocible.
  handoff: [
    { freq: 659.25, at: 0, dur: 0.22, type: 'triangle', gain: 0.3 },
    { freq: 880, at: 0.11, dur: 0.22, type: 'triangle', gain: 0.3 },
    { freq: 1318.5, at: 0.22, dur: 0.5, type: 'triangle', gain: 0.26 },
    { freq: 2637, at: 0.22, dur: 0.35, gain: 0.05 },
  ],
  // Mensaje nuevo del cliente en la conversación abierta: "pop" corto.
  incoming: [
    { freq: 520, at: 0, dur: 0.09, to: 780, gain: 0.18 },
    { freq: 1040, at: 0.06, dur: 0.12, gain: 0.08 },
  ],
  // Mensaje enviado: barrido rápido hacia arriba.
  sent: [{ freq: 380, at: 0, dur: 0.14, to: 1150, type: 'sine', gain: 0.14 }],
  tap: [{ freq: 1500, at: 0, dur: 0.035, type: 'square', gain: 0.025 }],
  success: [
    { freq: 784, at: 0, dur: 0.14, type: 'triangle', gain: 0.22 },
    { freq: 1175, at: 0.09, dur: 0.3, type: 'triangle', gain: 0.22 },
  ],
};

export function playSound(name: SoundName) {
  if (muted) return;
  play(SOUNDS[name]);
}
