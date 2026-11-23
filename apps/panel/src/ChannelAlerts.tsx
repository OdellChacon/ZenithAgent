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
  if (!down.length && !importing.length) return null;

  return (
    <div className="channel-alerts">
      {down.map((c) => (
        <div key={c.id} className="channel-alert down" role="alert">
          <b>{c.name} está desconectado de WhatsApp.</b> {c.disconnected!.label} El bot no recibe ni contesta mensajes en este número
          hasta que se vuelva a conectar; mientras tanto, atiendan desde el teléfono.
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
