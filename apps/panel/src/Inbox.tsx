import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, REASON_LABELS, type ConversationSummary, type Me, type View } from './api';
import { ago } from './time';
import { Camera, FileText, Inbox as InboxIcon, MapPin, Mic, PartyPopper, SearchX, UserRound, type LucideIcon } from 'lucide-react';
import { Avatar, Icon } from './ui';
import { EmptyState } from './EmptyState';
import { playSound } from './sounds';

const TABS: { view: View; label: string }[] = [
  { view: 'pending', label: 'Pendientes' },
  { view: 'mine', label: 'Mías' },
  { view: 'all', label: 'Todas' },
];

const EMPTY: Record<View, { icon: LucideIcon; title: string; text: string; tone: 'ok' | 'muted' }> = {
  pending: { icon: PartyPopper, title: 'Todo al día', text: 'No hay clientes esperando un asesor.', tone: 'ok' },
  mine: { icon: UserRound, title: 'Nada asignado', text: 'Cuando tomes una conversación, aparece aquí.', tone: 'muted' },
  all: { icon: InboxIcon, title: 'Bandeja vacía', text: 'Las conversaciones de WhatsApp aparecerán aquí.', tone: 'muted' },
};

const KIND_ICON: Record<string, LucideIcon> = { image: Camera, audio: Mic, location: MapPin, contacts: UserRound, document: FileText };

function Preview({ c }: { c: ConversationSummary }) {
  if (c.handoff?.summary) return <p className="preview">{c.handoff.summary}</p>;
  const m = c.lastMessage;
  if (!m) return <p className="preview">Sin mensajes</p>;
  const who = m.author === 'customer' ? null : m.author === 'bot' ? 'Bot' : m.author === 'agent' ? 'Asesor' : null;
  const Kind = KIND_ICON[m.type];
  const fallback = m.type === 'image' ? 'Foto' : m.type === 'audio' ? 'Nota de voz' : m.type === 'location' ? 'Ubicación' : m.type === 'contacts' ? 'Contacto' : '';
  return (
    <p className="preview">
      {who && <span className="who-tag">{who}: </span>}
      {Kind && <Kind className="preview-icon" strokeWidth={2} aria-hidden="true" />}
      {m.body ?? fallback}
    </p>
  );
}

const spring = { type: 'spring', stiffness: 480, damping: 38 } as const;

export function Inbox({ me, tick, selected, onSelect }: { me: Me; tick: number; selected: string | null; onSelect: (id: string) => void }) {
  const [view, setView] = useState<View>('pending');
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

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

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('es');
    if (!q || !items) return items;
    return items.filter((c) => `${c.contactName} ${c.lastMessage?.body ?? ''} ${c.handoff?.summary ?? ''}`.toLocaleLowerCase('es').includes(q));
  }, [items, query]);

  return (
    <aside className="inbox" aria-label="Bandeja">
      <div className="list-head">
        <div className="list-title">
          <h2>Bandeja</h2>
          {counts.pending ? <span>{counts.pending} esperando asesor</span> : <span>Al día</span>}
        </div>
        <label className="search-box">
          {Icon.search}
          <input
            className="search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar cliente o mensaje"
            aria-label="Buscar en la bandeja"
            maxLength={80}
          />
        </label>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.view}
              role="tab"
              aria-selected={view === t.view}
              className="tab"
              type="button"
              onClick={() => {
                if (view !== t.view) playSound('tap');
                setView(t.view);
              }}
            >
              {view === t.view && <motion.i className="tab-pill" layoutId="inbox-tab" transition={spring} />}
              <span>
                {t.label}
                <AnimatePresence initial={false}>
                  {counts[t.view] ? (
                    <motion.span
                      key={counts[t.view]}
                      className={`count ${t.view === 'pending' ? 'hot' : ''}`}
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.4, opacity: 0 }}
                      transition={{ type: 'spring', stiffness: 600, damping: 20 }}
                    >
                      {counts[t.view]}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </span>
            </button>
          ))}
        </nav>
      </div>

      {error && <p className="error pad">{error}</p>}
      {shown === null && !error && (
        <div className="skeleton" aria-label="Cargando">
          <i />
          <i />
          <i />
        </div>
      )}
      {shown?.length === 0 && (
        query ? (
          <EmptyState icon={SearchX} title="Sin resultados" text="Ninguna conversación coincide con la búsqueda." />
        ) : (
          <EmptyState icon={EMPTY[view].icon} title={EMPTY[view].title} text={EMPTY[view].text} tone={EMPTY[view].tone} />
        )
      )}
      <ul className="list">
        <AnimatePresence initial={true} mode="popLayout">
          {shown?.map((c, i) => {
            const phone = c.mode === 'human' && !c.assignedTo && !!c.agentPhoneAt;
            const waiting = c.mode === 'human' && !c.assignedTo && !phone;
            const withAgent = c.mode === 'human' && !waiting;
            return (
              <motion.li
                key={c.id}
                layout
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: -24, transition: { duration: 0.18 } }}
                transition={{ ...spring, delay: Math.min(i, 10) * 0.025 }}
              >
                <button
                  type="button"
                  className={`item ${selected === c.id ? 'active' : ''} ${waiting ? 'waiting' : ''} ${withAgent ? 'with-agent' : ''}`}
                  onClick={() => onSelect(c.id)}
                >
                  <Avatar name={c.contactName} channel={c.channel} waiting={waiting} />
                  <div className="item-top">
                    <b>{c.contactName}</b>
                    <span className="item-time">
                      {waiting && c.handoff ? `Espera · ${ago(c.handoff.requestedAt)}` : ago(c.updatedAt)}
                    </span>
                  </div>
                  <Preview c={c} />
                  <div className="chips">
                    {waiting && <span className="chip hot">Esperando asesor</span>}
                    {phone && <span className="chip ok">Asesor desde el teléfono</span>}
                    {c.assignedTo && <span className="chip ok">{c.assignedTo.id === me.id ? 'Contigo' : c.assignedTo.name}</span>}
                    {c.handoff && <span className="chip">{REASON_LABELS[c.handoff.reason] ?? c.handoff.reason}</span>}
                    {c.mode === 'bot' && <span className="chip muted-chip">Atiende el bot</span>}
                  </div>
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </aside>
  );
}
