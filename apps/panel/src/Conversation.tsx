import { Fragment, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, ApiError, CHANNEL_LABELS, REASON_LABELS, type ConversationDetail, type Me, type Message } from './api';
import { clock, remaining } from './time';
import { TagEditor } from './tags';
import { Avatar, Icon, Ticks } from './ui';
import { playSound } from './sounds';

const WINDOW_MS = 24 * 3_600_000;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
}

const DELIVERY_LABELS: Record<string, string> = {
  queued: 'En cola',
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'No se envió',
  blocked_window: 'Bloqueado: ventana de 24 h cerrada',
};

/** Coordenadas al final del texto de una ubicación: "… (7.76690, -72.22500)". */
const COORDS = /\((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)$|^(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)$/;

/** Lo que manda el cliente que no es texto: nota de voz transcrita, ubicación, contactos, archivos. */
function CustomerMedia({ m }: { m: Message }) {
  const body = m.body?.trim() ?? '';
  if (m.type === 'audio') {
    return body ? (
      <p>
        <span className="muted">[Nota de voz, transcrita]</span> {body}
      </p>
    ) : (
      <p className="muted">[Nota de voz del cliente: no se pudo transcribir]</p>
    );
  }
  if (m.type === 'location') {
    const c = COORDS.exec(body);
    const lat = c?.[1] ?? c?.[3];
    const lng = c?.[2] ?? c?.[4];
    const label = body.replace(COORDS, '').trim();
    return (
      <p>
        <span className="muted">[Ubicación]</span> {label || 'Sin nombre'}{' '}
        {lat && lng && (
          <a href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noopener noreferrer">
            Ver en el mapa
          </a>
        )}
      </p>
    );
  }
  if (m.type === 'contacts') {
    return (
      <p>
        <span className="muted">[Contacto compartido]</span> {body}
      </p>
    );
  }
  const kind = m.type === 'image' ? 'Foto' : m.type === 'sticker' ? 'Sticker' : m.type === 'video' ? 'Video' : 'Archivo';
  return <p className="muted">[{kind} del cliente]{body ? ` ${body}` : ''}</p>;
}

function Bubble({ m, fresh }: { m: Message; fresh: boolean }) {
  const who =
    m.author === 'customer'
      ? null
      : m.author === 'bot'
        ? m.followup === 2
          ? 'Bot · seguimiento con plantilla'
          : m.followup === 1
            ? 'Bot · seguimiento'
            : 'Bot'
        : m.author === 'agent'
          ? (m.sentBy ?? 'Asesor · desde el teléfono')
          : 'Sistema';
  return (
    <motion.div
      className={`msg ${m.direction} ${m.author}`}
      layout="position"
      initial={fresh ? { opacity: 0, y: 14, scale: 0.92 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 520, damping: 32 }}
    >
      {who && <span className="who">{who}</span>}
      {m.type === 'image' && m.imageId ? (
        <figure>
          <img src={`/api/v1/product-images/${m.imageId}`} alt={m.body ?? 'Foto del producto'} loading="lazy" />
          {m.body && <figcaption>{m.body}</figcaption>}
        </figure>
      ) : m.type !== 'text' && m.author === 'agent' && !m.sentBy ? (
        <p className="muted">[{m.type === 'image' ? 'Foto' : m.type === 'audio' ? 'Nota de voz' : m.type === 'video' ? 'Video' : 'Archivo'} enviado desde el teléfono]{m.body ? ` ${m.body}` : ''}</p>
      ) : m.direction === 'in' && m.type !== 'text' ? (
        <CustomerMedia m={m} />
      ) : (
        <p>{m.body}</p>
      )}
      <span className="meta" title={m.direction === 'out' && m.delivery ? (DELIVERY_LABELS[m.delivery] ?? m.delivery) : undefined}>
        {clock(m.at)}
        {m.direction === 'out' && m.delivery && <Ticks state={m.delivery} />}
        {m.direction === 'out' && (m.delivery === 'failed' || m.delivery === 'blocked_window') && <span>{DELIVERY_LABELS[m.delivery]}</span>}
      </span>
    </motion.div>
  );
}

export function Conversation({
  id,
  me,
  tick,
  onClose,
  onChanged,
  onOpenContact,
}: {
  id: string;
  me: Me;
  tick: number;
  onClose: () => void;
  onChanged: () => void;
  onOpenContact: (contactId: string) => void;
}) {
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setNow] = useState(Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(id)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((err) => !cancelled && setError(err instanceof ApiError && err.status === 404 ? 'Esta conversación no existe.' : 'No se pudo cargar.'));
    return () => {
      cancelled = true;
    };
  }, [id, tick]);

  // Para la cuenta regresiva de la ventana de 24 h.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Mensajes ya mostrados: solo los nuevos entran con animación (y suenan si son del cliente).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    if (seen.current) {
      const fresh = data.messages.filter((m) => !seen.current!.has(m.id));
      if (fresh.some((m) => m.author === 'customer')) playSound('incoming');
    }
    seen.current = new Set(data.messages.map((m) => m.id));
  }, [data]);

  const firstScroll = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: firstScroll.current ? 'instant' : 'smooth' });
    if (data) firstScroll.current = false;
  }, [data?.messages.length]);

  if (error) return <section className="conversation"><p className="error pad">{error}</p></section>;
  if (!data) return <section className="conversation"><p className="muted pad">Cargando…</p></section>;

  const mine = data.assignedTo?.id === me.id;
  const otherAgent = data.assignedTo && !mine;
  const windowLeft = remaining(data.window.expiresAt);
  const canWrite = mine && data.window.state === 'FREE';

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      onChanged();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'No se pudo completar la acción.');
    } finally {
      setBusy(false);
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || !canWrite) return;
    const clientId = crypto.randomUUID();
    await act(async () => {
      await api.send(id, body, clientId);
      setText('');
      playSound('sent');
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  let status: { label: string; tone: string };
  if (data.mode === 'bot') status = { label: 'Lo atiende el bot', tone: 'muted-chip' };
  else if (!data.assignedTo && data.agentPhoneAt) status = { label: 'Lo atiende un asesor desde el teléfono', tone: 'ok' };
  else if (!data.assignedTo) status = { label: 'Esperando asesor', tone: 'hot' };
  else status = { label: mine ? 'Lo atiendes tú' : `Lo atiende ${data.assignedTo.name}`, tone: 'ok' };

  let composerHint: string | null = null;
  if (!mine) composerHint = otherAgent ? `Esta conversación la atiende ${data.assignedTo!.name}.` : 'Toma la conversación para responder.';
  else if (data.window.state !== 'FREE')
    composerHint = 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas (aún no disponibles en el panel).';

  return (
    <section className="conversation" aria-label={`Conversación con ${data.contact.name}`}>
      <div className="conv-head">
        <button className="icon-btn back" type="button" onClick={onClose} aria-label="Volver a la bandeja">
          {Icon.back}
        </button>
        <div className="conv-who">
          <Avatar name={data.contact.name} channel={data.channel} />
          <div className="conv-title">
            <b>{data.contact.name}</b>
            <span className="muted small">
              {CHANNEL_LABELS[data.channel] ?? data.channel}
              {data.contact.phone ? ` · +${data.contact.phone}` : ''}
            </span>
          </div>
        </div>
        <span className={`chip ${status.tone}`}>{status.label}</span>
        <div className="conv-actions">
          {!mine && data.status !== 'closed' && (me.role !== 'agent' || !otherAgent) && (
            <button className="btn primary" type="button" disabled={busy} onClick={() => act(() => api.take(id), 'Tomaste la conversación. El bot no responderá mientras la atiendes.')}>
              Tomar conversación
            </button>
          )}
          {data.mode === 'human' && (mine || me.role !== 'agent') && (
            <>
              <button className="btn" type="button" disabled={busy} onClick={() => act(() => api.finish(id, 'release'), 'El bot vuelve a atender a este cliente.')}>
                Devolver al bot
              </button>
              <button className="btn ghost" type="button" disabled={busy} onClick={() => act(() => api.finish(id, 'close'), 'Conversación cerrada.')}>
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>

      <div className="conv-tags">
        <TagEditor
          compact
          contactId={data.contact.id}
          tags={data.contact.tags}
          onSaved={(tags) => setData({ ...data, contact: { ...data.contact, tags } })}
        />
        <button className="btn ghost small" type="button" onClick={() => onOpenContact(data.contact.id)}>
          Ver ficha
        </button>
      </div>

      {data.handoff && !data.handoff.returnedAt && (
        <div className="handoff">
          <b>{REASON_LABELS[data.handoff.reason] ?? data.handoff.reason}</b>
          <p>{data.handoff.summary ?? 'Sin resumen del bot.'}</p>
        </div>
      )}

      <div className="window-line">
        {data.window.state === 'FREE' && windowLeft ? (
          <>
            <span>Ventana de WhatsApp abierta: quedan <b>{windowLeft}</b> para responder con texto libre.</span>
            <span className="window-bar" aria-hidden="true">
              <i style={{ width: `${Math.max(2, Math.min(100, ((new Date(data.window.expiresAt!).getTime() - Date.now()) / WINDOW_MS) * 100))}%` }} />
            </span>
          </>
        ) : (
          <span className="warn">Ventana de 24 h cerrada.</span>
        )}
      </div>

      <div className="messages" ref={listRef}>
        {data.messages.map((m, i) => {
          const prev = data.messages[i - 1];
          const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
          return (
            <Fragment key={m.id}>
              {newDay && <span className="day-sep">{dayLabel(m.at)}</span>}
              <Bubble m={m} fresh={!!seen.current && !seen.current.has(m.id)} />
            </Fragment>
          );
        })}
      </div>

      <AnimatePresence>
        {notice && (
          <motion.p
            className="notice"
            role="status"
            initial={{ opacity: 0, y: 8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: 'auto' }}
            exit={{ opacity: 0, y: 8, height: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
          >
            {notice}
          </motion.p>
        )}
      </AnimatePresence>

      <form className="composer" onSubmit={send}>
        {composerHint ? (
          <p className="muted small hint">{composerHint}</p>
        ) : (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Escribe tu respuesta… (Enter envía, Shift+Enter nueva línea)"
              maxLength={4096}
              rows={2}
              aria-label="Respuesta al cliente"
            />
            <motion.button
              className="btn primary"
              type="submit"
              disabled={busy || !text.trim() || !canWrite}
              whileTap={{ scale: 0.92 }}
              animate={{ opacity: text.trim() ? 1 : 0.55 }}
            >
              Enviar {Icon.send}
            </motion.button>
          </>
        )}
      </form>
    </section>
  );
}
