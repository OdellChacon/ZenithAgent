import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError, CHANNEL_LABELS, REASON_LABELS, type ConversationDetail, type Me, type Message } from './api';
import { clock, remaining } from './time';
import { TagEditor } from './TagEditor';

const DELIVERY_LABELS: Record<string, string> = {
  queued: 'En cola',
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'No se envió',
  blocked_window: 'Bloqueado: ventana de 24 h cerrada',
};

function Bubble({ m }: { m: Message }) {
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
          ? (m.sentBy ?? 'Asesor')
          : 'Sistema';
  return (
    <div className={`msg ${m.direction} ${m.author}`}>
      {who && <span className="who">{who}</span>}
      {m.type === 'image' && m.imageId ? (
        <figure>
          <img src={`/api/v1/product-images/${m.imageId}`} alt={m.body ?? 'Foto del producto'} loading="lazy" />
          {m.body && <figcaption>{m.body}</figcaption>}
        </figure>
      ) : m.type !== 'text' && m.direction === 'in' ? (
        <p className="muted">[{m.type === 'image' ? 'Foto' : m.type === 'audio' ? 'Nota de voz' : 'Archivo'} del cliente]{m.body ? ` ${m.body}` : ''}</p>
      ) : (
        <p>{m.body}</p>
      )}
      <span className="meta">
        {clock(m.at)}
        {m.direction === 'out' && m.delivery ? ` · ${DELIVERY_LABELS[m.delivery] ?? m.delivery}` : ''}
      </span>
    </div>
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

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
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
  else if (!data.assignedTo) status = { label: 'Esperando asesor', tone: 'hot' };
  else status = { label: mine ? 'Lo atiendes tú' : `Lo atiende ${data.assignedTo.name}`, tone: 'ok' };

  let composerHint: string | null = null;
  if (!mine) composerHint = otherAgent ? `Esta conversación la atiende ${data.assignedTo!.name}.` : 'Toma la conversación para responder.';
  else if (data.window.state !== 'FREE')
    composerHint = 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas (aún no disponibles en el panel).';

  return (
    <section className="conversation" aria-label={`Conversación con ${data.contact.name}`}>
      <div className="conv-head">
        <button className="btn ghost back" type="button" onClick={onClose} aria-label="Volver a la bandeja">
          ←
        </button>
        <div className="conv-title">
          <b>{data.contact.name}</b>
          <span className="muted small">
            {CHANNEL_LABELS[data.channel] ?? data.channel}
            {data.contact.phone ? ` · +${data.contact.phone}` : ''}
          </span>
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
          <span>Ventana de WhatsApp abierta: quedan <b>{windowLeft}</b> para responder con texto libre.</span>
        ) : (
          <span className="warn">Ventana de 24 h cerrada.</span>
        )}
      </div>

      <div className="messages" ref={listRef}>
        {data.messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

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
            <button className="btn primary" type="submit" disabled={busy || !text.trim() || !canWrite}>
              Enviar
            </button>
          </>
        )}
      </form>
    </section>
  );
}
