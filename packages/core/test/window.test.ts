import { describe, expect, it } from 'vitest';
import { HUMAN_AGENT_WINDOW_MS, STANDARD_WINDOW_MS, windowExpiresAt, windowState } from '../src/window.js';

const last = new Date('2026-11-20T10:00:00Z');
const at = (ms: number) => new Date(last.getTime() + ms);
const MIN = 60_000;

describe('windowState', () => {
  it('permite texto libre dentro de las 24 h en todos los canales', () => {
    for (const channel of ['whatsapp', 'instagram', 'messenger', 'tiktok'] as const) {
      expect(windowState({ channel, lastInboundAt: last, now: at(STANDARD_WINDOW_MS - 1), author: 'bot' })).toBe('FREE');
    }
  });

  it('cierra el texto libre exactamente a las 24 h', () => {
    expect(windowState({ channel: 'whatsapp', lastInboundAt: last, now: at(STANDARD_WINDOW_MS), author: 'bot' })).toBe(
      'TEMPLATE_ONLY',
    );
  });

  it('en Instagram y Messenger el bot no puede escribir pasadas las 24 h', () => {
    for (const channel of ['instagram', 'messenger'] as const) {
      expect(windowState({ channel, lastInboundAt: last, now: at(STANDARD_WINDOW_MS + MIN), author: 'bot' })).toBe(
        'CLOSED',
      );
    }
  });

  it('en Instagram y Messenger una persona puede responder con Human Agent hasta los 7 días', () => {
    expect(
      windowState({ channel: 'instagram', lastInboundAt: last, now: at(STANDARD_WINDOW_MS + MIN), author: 'agent' }),
    ).toBe('HUMAN_AGENT_ONLY');
    expect(
      windowState({ channel: 'messenger', lastInboundAt: last, now: at(HUMAN_AGENT_WINDOW_MS - 1), author: 'agent' }),
    ).toBe('HUMAN_AGENT_ONLY');
    expect(
      windowState({ channel: 'messenger', lastInboundAt: last, now: at(HUMAN_AGENT_WINDOW_MS), author: 'agent' }),
    ).toBe('CLOSED');
  });

  it('en WhatsApp fuera de ventana solo hay plantilla, también para personas', () => {
    expect(
      windowState({ channel: 'whatsapp', lastInboundAt: last, now: at(STANDARD_WINDOW_MS * 3), author: 'agent' }),
    ).toBe('TEMPLATE_ONLY');
  });

  it('TikTok queda cerrado fuera de 24 h mientras sus reglas estén por verificar', () => {
    expect(windowState({ channel: 'tiktok', lastInboundAt: last, now: at(STANDARD_WINDOW_MS), author: 'agent' })).toBe(
      'CLOSED',
    );
  });

  it('sin mensajes del usuario: plantilla en WhatsApp, cerrado en los demás', () => {
    expect(windowState({ channel: 'whatsapp', lastInboundAt: null, now: last, author: 'bot' })).toBe('TEMPLATE_ONLY');
    expect(windowState({ channel: 'instagram', lastInboundAt: null, now: last, author: 'agent' })).toBe('CLOSED');
  });

  it('el margen de seguridad adelanta el cierre solo para el bot', () => {
    const now = at(STANDARD_WINDOW_MS - 5 * MIN);
    const margin = 10 * MIN;
    expect(windowState({ channel: 'whatsapp', lastInboundAt: last, now, author: 'bot', botSafetyMarginMs: margin })).toBe(
      'TEMPLATE_ONLY',
    );
    expect(
      windowState({ channel: 'whatsapp', lastInboundAt: last, now, author: 'agent', botSafetyMarginMs: margin }),
    ).toBe('FREE');
  });

  it('un reloj atrasado no rompe el cálculo', () => {
    expect(windowState({ channel: 'whatsapp', lastInboundAt: last, now: at(-MIN), author: 'bot' })).toBe('FREE');
  });
});

describe('windowExpiresAt', () => {
  it('suma 24 h al último mensaje del usuario', () => {
    expect(windowExpiresAt(last).toISOString()).toBe('2026-11-21T10:00:00.000Z');
  });
});
