import { useEffect, useState } from 'react';
import { api, CHANNEL_LABELS, REASON_LABELS, type ConversationSummary, type Me, type View } from './api';
import { ago } from './time';

const TABS: { view: View; label: string }[] = [
  { view: 'pending', label: 'Pendientes' },
  { view: 'mine', label: 'Mías' },
  { view: 'all', label: 'Todas' },
];

function preview(c: ConversationSummary): string {
  if (c.handoff?.summary) return c.handoff.summary;
  const m = c.lastMessage;
  if (!m) return 'Sin mensajes';
  const who = m.author === 'customer' ? '' : m.author === 'bot' ? 'Bot: ' : 'Asesor: ';
  return who + (m.type === 'image' ? `📷 ${m.body ?? 'Foto'}` : (m.body ?? ''));
}

export function Inbox({ me, tick, selected, onSelect }: { me: Me; tick: number; selected: string | null; onSelect: (id: string) => void }) {
  const [view, setView] = useState<View>('pending');
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [current, pending, mine] = await Promise.all([api.list(view), api.list('pending'), api.list('mine')]);
        if (cancelled) return;
        setItems(current.items);
        setCounts({ pending: pending.items.length, mine: mine.items.length });
        setError(null);
      } catch {
        if (!cancelled) setError('No se pudo cargar la bandeja.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, tick]);

  return (
    <aside className="inbox" aria-label="Bandeja">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.view} role="tab" aria-selected={view === t.view} className="tab" type="button" onClick={() => setView(t.view)}>
            {t.label}
            {counts[t.view] ? <span className={`count ${t.view === 'pending' ? 'hot' : ''}`}>{counts[t.view]}</span> : null}
          </button>
        ))}
      </nav>
      {error && <p className="error pad">{error}</p>}
      {items === null && !error && <p className="muted pad">Cargando…</p>}
      {items?.length === 0 && (
        <p className="muted pad">{view === 'pending' ? 'No hay clientes esperando. 🎉' : view === 'mine' ? 'No tienes conversaciones asignadas.' : 'Sin conversaciones.'}</p>
      )}
      <ul className="list">
        {items?.map((c) => {
          const waiting = c.mode === 'human' && !c.assignedTo;
          return (
            <li key={c.id}>
              <button type="button" className={`item ${selected === c.id ? 'active' : ''}`} onClick={() => onSelect(c.id)}>
                <div className="item-top">
                  <b>{c.contactName}</b>
                  <span className="muted small">{ago(c.handoff && waiting ? c.handoff.requestedAt : c.updatedAt)}</span>
                </div>
                <div className="chips">
                  <span className="chip">{CHANNEL_LABELS[c.channel] ?? c.channel}</span>
                  {waiting && <span className="chip hot">Esperando asesor</span>}
                  {c.handoff && <span className="chip">{REASON_LABELS[c.handoff.reason] ?? c.handoff.reason}</span>}
                  {c.assignedTo && <span className="chip ok">{c.assignedTo.id === me.id ? 'Contigo' : c.assignedTo.name}</span>}
                  {c.mode === 'bot' && <span className="chip muted-chip">Bot</span>}
                </div>
                <p className="preview">{preview(c)}</p>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
