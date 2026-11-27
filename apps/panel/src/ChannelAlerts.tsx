import { useEffect, useState } from 'react';
import { api, type ChannelStatus } from './api';

/**
 * Franja bajo la barra superior cuando Meta desconectó un número (el bot dejó de atender ahí)
 * o mientras se importa el historial de chats del teléfono.
 */
export function ChannelAlerts({ tick }: { tick: number }) {
  const [items, setItems] = useState<ChannelStatus[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .channels()
      .then((r) => alive && setItems(r.items))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick]);

  const down = items.filter((c) => c.disconnected);
  const importing = items.filter((c) => c.history?.status === 'importing');
  const noAccess = items.filter((c) => !c.disconnected && c.token?.invalid);
  const WEEK = 7 * 24 * 3_600_000;
  const expiring = items.filter(
    (c) => !c.token?.invalid && c.token?.expiresAt && new Date(c.token.expiresAt).getTime() - Date.now() < WEEK,
  );
  if (!down.length && !importing.length && !noAccess.length && !expiring.length) return null;

  return (
    <div className="channel-alerts">
      {down.map((c) => (
        <div key={c.id} className="channel-alert down" role="alert">
          <b>{c.name} está desconectado de WhatsApp.</b> {c.disconnected!.label} El bot no recibe ni contesta mensajes en este número
          hasta que se vuelva a conectar; mientras tanto, atiendan desde el teléfono.
        </div>
      ))}
      {noAccess.map((c) => (
        <div key={c.id} className="channel-alert down" role="alert">
          <b>{c.name}: Meta rechazó el acceso del sistema.</b> El permiso venció o alguien quitó la app de la cuenta. El bot no puede
          enviar mensajes ahí hasta que un administrador vuelva a conectarla.
        </div>
      ))}
      {expiring.map((c) => (
        <div key={c.id} className="channel-alert">
          El acceso a {c.name} vence el{' '}
          {new Date(c.token.expiresAt!).toLocaleDateString('es-VE', { day: 'numeric', month: 'long' })}. Vuelvan a conectarla antes para que
          el bot no deje de responder.
        </div>
      ))}
      {importing.map((c) => (
        <div key={c.id} className="channel-alert">
          Importando los chats anteriores de {c.name} ({c.history!.progress}%). Aparecen en la bandeja a medida que llegan.
        </div>
      ))}
    </div>
  );
}
