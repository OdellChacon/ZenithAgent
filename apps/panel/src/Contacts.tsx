import { useEffect, useState } from 'react';
import { api, ApiError, CHANNEL_LABELS, REASON_LABELS, type ContactDetail, type ContactSummary } from './api';
import { TagChip, TagEditor, tagDef, tagLabel, useTagCatalog } from './tags';
import { TagManager } from './TagManager';
import { ago } from './time';
import { motion, AnimatePresence } from 'motion/react';
import { ContactRound, SearchX, UsersRound } from 'lucide-react';
import { Avatar, Icon } from './ui';
import { EmptyState } from './EmptyState';

/** Señales que salen de los datos (no las escribe nadie): ayudan a priorizar. */
function Signals({ c }: { c: ContactSummary }) {
  return (
    <>
      {c.conversation?.waitingAdvisor && <span className="chip hot">Esperando asesor</span>}
      {c.conversation?.mode === 'human' && !c.conversation.waitingAdvisor && c.conversation.status !== 'closed' && (
        <span className="chip ok">Con asesor</span>
      )}
      {c.lastHandoffReason && <span className="chip">{REASON_LABELS[c.lastHandoffReason] ?? c.lastHandoffReason}</span>}
      {c.followupSent && <span className="chip muted-chip">Seguimiento enviado</span>}
      {c.optOutFollowups && <span className="chip warn-chip">No escribirle</span>}
    </>
  );
}

function interestLine(c: ContactSummary): string | null {
  if (c.interest.products.length) return `Vio: ${c.interest.products.join(', ')}`;
  if (c.interest.categories.length) return `Interés: ${c.interest.categories.join(', ')}`;
  return null;
}

export function Contacts({
  tick,
  selected,
  onSelect,
  onOpenConversation,
}: {
  tick: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenConversation: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const catalog = useTagCatalog();
  const [managing, setManaging] = useState(false);
  const [items, setItems] = useState<ContactSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Si cambian las etiquetas (renombrar, unir, borrar), la lista se vuelve a pedir.
  useEffect(() => setReload((r) => r + 1), [catalog]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.contacts({ ...(debounced ? { q: debounced } : {}), ...(tag ? { tag } : {}) })])
      .then(([list]) => {
        if (cancelled) return;
        setItems(list.items);
        setError(null);
      })
      .catch(() => !cancelled && setError('No se pudieron cargar los contactos.'));
    return () => {
      cancelled = true;
    };
  }, [debounced, tag, tick, reload]);

  return (
    <div className={`workspace ${selected ? 'has-selection' : ''}`}>
      <TagManager open={managing} onClose={() => setManaging(false)} />
      <aside className="inbox" aria-label="Contactos">
        <div className="list-head">
          <div className="list-title">
            <h2>Contactos</h2>
            {items && <span>{items.length} {items.length === 1 ? 'contacto' : 'contactos'}</span>}
          </div>
          <div className="contact-filters">
            <label className="search-box">
              {Icon.search}
              <input
                className="search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nombre, teléfono o etiqueta"
                aria-label="Buscar contactos"
                maxLength={80}
              />
            </label>
            <div className="tag-filter-bar">
              <div className="tag-filter" role="group" aria-label="Filtrar por etiqueta">
                {(catalog?.items ?? [])
                  .filter((t) => t.count > 0 || tag === t.tag)
                  .map((t) => (
                    <button
                      key={t.tag}
                      type="button"
                      className={`tfilter tc-${t.color} ${tag === t.tag ? 'on' : ''}`}
                      aria-pressed={tag === t.tag}
                      title={[t.group, t.description].filter(Boolean).join(' · ') || undefined}
                      onClick={() => setTag(tag === t.tag ? null : t.tag)}
                    >
                      <i aria-hidden="true" />
                      {tagLabel(t.tag)}
                      <span>{t.count}</span>
                    </button>
                  ))}
              </div>
              <button type="button" className="btn ghost small tag-manage" onClick={() => setManaging(true)}>
                {Icon.tags}
                Gestionar etiquetas
              </button>
            </div>
          </div>
        </div>
        {error && <p className="error pad">{error}</p>}
        {items === null && !error && (
          <div className="skeleton" aria-label="Cargando">
            <i />
            <i />
            <i />
          </div>
        )}
        {items?.length === 0 && (
          debounced || tag ? (
            <EmptyState icon={SearchX} title="Sin resultados" text="Ningún contacto coincide con la búsqueda o la etiqueta." />
          ) : (
            <EmptyState icon={UsersRound} title="Sin contactos todavía" text="Cada cliente que escriba por WhatsApp aparecerá aquí." />
          )
        )}
        <ul className="list">
          <AnimatePresence initial={true} mode="popLayout">
            {items?.map((c, i) => {
              const interest = interestLine(c);
              const waiting = !!c.conversation?.waitingAdvisor;
              const withAgent = c.conversation?.mode === 'human' && !waiting && c.conversation.status !== 'closed';
              return (
                <motion.li
                  key={c.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ type: 'spring', stiffness: 480, damping: 38, delay: Math.min(i, 10) * 0.025 }}
                >
                  <button
                    type="button"
                    className={`item ${selected === c.id ? 'active' : ''} ${waiting ? 'waiting' : ''} ${withAgent ? 'with-agent' : ''}`}
                    onClick={() => onSelect(c.id)}
                  >
                    <Avatar name={c.name} channel={c.channels[0]} waiting={waiting} />
                    <div className="item-top">
                      <b>{c.name}</b>
                      <span className="item-time">{ago(c.lastActivityAt)}</span>
                    </div>
                    <div className="item-sub">{c.phone ? `+${c.phone}` : c.channels.map((ch) => CHANNEL_LABELS[ch] ?? ch).join(' · ')}</div>
                    {interest && <p className="interest">{interest}</p>}
                    {(c.tags.length > 0 || waiting || withAgent || c.lastHandoffReason || c.followupSent || c.optOutFollowups) && (
                      <div className="chips">
                        {c.tags.map((t) => (
                          <TagChip key={t} tag={t} color={tagDef(catalog, t)?.color ?? 'gray'} />
                        ))}
                        <Signals c={c} />
                      </div>
                    )}
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      </aside>
      {selected ? (
        <ContactPane
          key={selected}
          id={selected}
          tick={tick}
          onClose={() => onSelect(null)}
          onChanged={() => setReload((r) => r + 1)}
          onOpenConversation={onOpenConversation}
        />
      ) : (
        <div className="empty-pane">
          <EmptyState
            size="lg"
            tone="accent"
            icon={ContactRound}
            title="Elige un contacto"
            text="Ponles etiquetas (mayorista, arquitecto, obra…) para encontrarlos y priorizarlos."
          />
        </div>
      )}
    </div>
  );
}

function ContactPane({
  id,
  tick,
  onClose,
  onChanged,
  onOpenConversation,
}: {
  id: string;
  tick: number;
  onClose: () => void;
  onChanged: () => void;
  onOpenConversation: (id: string) => void;
}) {
  const [data, setData] = useState<ContactDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null: el asesor no está editando, se muestran las notas guardadas.
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .contact(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError && err.status === 404 ? 'Este contacto no existe.' : 'No se pudo cargar.'));
    return () => {
      cancelled = true;
    };
  }, [id, tick]);

  if (error) return <section className="conversation"><p className="error pad">{error}</p></section>;
  if (!data) return <section className="conversation"><p className="muted pad">Cargando…</p></section>;

  const update = async (patch: Parameters<typeof api.updateContact>[1], done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await api.updateContact(id, patch);
      setData({ ...data, ...patch } as ContactDetail);
      if ('notes' in patch) setDraft(null);
      setNotice(done);
      onChanged();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const notes = draft ?? data.notes ?? '';
  const notesChanged = draft !== null && draft.trim() !== (data.notes ?? '');

  return (
    <section className="conversation contact-pane" aria-label={`Ficha de ${data.name}`}>
      <div className="conv-head">
        <button className="btn ghost back" type="button" onClick={onClose} aria-label="Volver a contactos">
          ←
        </button>
        <div className="conv-title">
          <b>{data.name}</b>
          <span className="muted small">
            {data.channels.map((ch) => CHANNEL_LABELS[ch] ?? ch).join(' · ') || 'Sin canal'}
            {data.phone ? ` · +${data.phone}` : ''}
          </span>
        </div>
        {data.conversation && (
          <button className="btn primary" type="button" onClick={() => onOpenConversation(data.conversation!.id)}>
            Abrir conversación
          </button>
        )}
      </div>

      <div className="contact-body">
        <div className="chips">
          <Signals c={data} />
        </div>

        <div className="field">
          <span className="label">Etiquetas</span>
          <TagEditor contactId={id} tags={data.tags} onSaved={(tags) => (setData({ ...data, tags }), onChanged())} />
        </div>

        {(data.interest.products.length > 0 || data.interest.categories.length > 0) && (
          <div className="field">
            <span className="label">Le mostró el bot</span>
            <p>
              {data.interest.products.join(', ')}
              {data.interest.categories.length > 0 && <span className="muted"> · {data.interest.categories.join(', ')}</span>}
            </p>
          </div>
        )}

        <label className="field">
          <span className="label">Notas del equipo</span>
          <textarea value={notes} maxLength={2000} rows={3} onChange={(e) => setDraft(e.target.value)} placeholder="Ej.: es arquitecto, prefiere que le escriban en la tarde." />
        </label>
        {notesChanged && (
          <div>
            <button className="btn" type="button" disabled={busy} onClick={() => update({ notes: notes.trim() || null }, 'Notas guardadas.')}>
              Guardar notas
            </button>
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={data.optOutFollowups}
            disabled={busy}
            onChange={(e) =>
              update(
                { optOutFollowups: e.target.checked },
                e.target.checked ? 'No se le enviarán seguimientos automáticos.' : 'Se le pueden volver a enviar seguimientos.',
              )
            }
          />
          No enviarle seguimientos automáticos
        </label>

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        <div className="field">
          <span className="label">Conversaciones</span>
          <ul className="conv-list">
            {data.conversations.map((c) => (
              <li key={c.id}>
                <button type="button" className="item" onClick={() => onOpenConversation(c.id)}>
                  <div className="item-top">
                    <span>
                      {CHANNEL_LABELS[c.channel] ?? c.channel} · {c.status === 'closed' ? 'Cerrada' : c.mode === 'human' ? 'Con asesor' : 'Con el bot'}
                    </span>
                    <span className="muted small">{ago(c.updatedAt)}</span>
                  </div>
                  {c.lastMessage && (
                    <p className="preview">
                      {c.lastMessage.author === 'customer' ? '' : c.lastMessage.author === 'bot' ? 'Bot: ' : 'Asesor: '}
                      {c.lastMessage.type === 'image' ? `📷 ${c.lastMessage.body ?? 'Foto'}` : (c.lastMessage.body ?? '')}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
