import { Fragment, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, ApiError, CATALOG_DRAG_TYPE, CHANNEL_LABELS, REASON_LABELS, type Catalog, type ConversationDetail, type Me, type Message } from './api';
import { CatalogShelf } from './Catalogs';
import { clock, remaining } from './time';
import { TagEditor } from './tags';
import { TemplateComposer } from './TemplateComposer';
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

/** Lo que acepta el botón de adjuntar; la API revisa el tipo real y lo que admite cada canal. */
const ATTACH_ACCEPT = 'image/jpeg,image/png,video/mp4,video/3gpp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';
const ATTACH_MAX_BYTES = 16 * 1024 * 1024;

/** Foto, video, audio o documento de un mensaje. Los del cliente se piden a Meta al abrirlos. */
function FileView({ f, caption }: { f: NonNullable<Message['file']>; caption: string | null }) {
  const [broken, setBroken] = useState(false);
  const text = caption?.trim() || null;
  if (broken) return <p className="muted">[El archivo ya no está disponible en Meta]{text ? ` ${text}` : ''}</p>;
  if (f.mediaType === 'image' || f.mediaType === 'sticker') {
    return (
      <figure>
        <img src={f.url} alt={text ?? 'Foto'} loading="lazy" onError={() => setBroken(true)} />
        {text && <figcaption>{text}</figcaption>}
      </figure>
    );
  }
  if (f.mediaType === 'video') {
    return (
      <figure>
        <video src={f.url} controls preload="metadata" onError={() => setBroken(true)} />
        {text && <figcaption>{text}</figcaption>}
      </figure>
    );
  }
  return (
    <figure>
      <a className="file-link" href={f.url} target="_blank" rel="noopener noreferrer">
        {Icon.file}
        <span>{f.name ?? 'Documento'}</span>
      </a>
      {text && <figcaption>{text}</figcaption>}
    </figure>
  );
}

/** Lo que manda el cliente que no es texto: nota de voz transcrita, ubicación, contactos, archivos. */
function CustomerMedia({ m }: { m: Message }) {
  const body = m.body?.trim() ?? '';
  if (m.type === 'audio') {
    return (
      <>
        {body ? (
          <p>
            <span className="muted">[Nota de voz, transcrita]</span> {body}
          </p>
        ) : (
          <p className="muted">[Nota de voz del cliente: no se pudo transcribir]</p>
        )}
        {m.file && <audio src={m.file.url} controls preload="none" />}
      </>
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
          ? `${m.sentBy ?? 'Asesor · desde el teléfono'}${m.type === 'template' ? ' · plantilla' : ''}`
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
      {m.deletedAt ? (
        <p className="muted deleted">{m.direction === 'in' ? 'El cliente eliminó este mensaje' : 'Mensaje eliminado'}</p>
      ) : m.type === 'image' && m.imageId ? (
        <figure>
          <img src={`/api/v1/product-images/${m.imageId}`} alt={m.body ?? 'Foto del producto'} loading="lazy" />
          {m.body && <figcaption>{m.body}</figcaption>}
        </figure>
      ) : m.file && m.type !== 'audio' ? (
        <FileView f={m.file} caption={m.body} />
      ) : m.type !== 'text' && m.author === 'agent' && !m.sentBy ? (
        <p className="muted">[{m.type === 'image' ? 'Foto' : m.type === 'audio' ? 'Nota de voz' : m.type === 'video' ? 'Video' : 'Archivo'} enviado desde el teléfono]{m.body ? ` ${m.body}` : ''}</p>
      ) : m.direction === 'in' && m.type !== 'text' ? (
        <CustomerMedia m={m} />
      ) : (
        <p>{m.body}</p>
      )}
      <span className="meta" title={m.direction === 'out' && m.delivery ? (DELIVERY_LABELS[m.delivery] ?? m.delivery) : undefined}>
        {m.editedAt && !m.deletedAt && <span>editado ·</span>}
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
  const [file, setFile] = useState<File | null>(null);
  // Catálogo listo para mandar (arrastrado desde el estante). Va en lugar de un archivo.
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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
  const metaChannel = data.channel === 'messenger' || data.channel === 'instagram';
  // Messenger e Instagram: entre 24 h y 7 días solo responde una persona (etiqueta Human Agent).
  const canWrite = mine && (data.window.state === 'FREE' || (metaChannel && data.window.state === 'HUMAN_AGENT_ONLY'));

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
    if ((!body && !file && !catalog) || !canWrite) return;
    const clientId = crypto.randomUUID();
    await act(async () => {
      if (catalog) await api.shareCatalog(id, catalog.id, body, clientId);
      else if (file) await api.sendFile(id, file, body, clientId);
      else await api.send(id, body, clientId);
      setText('');
      setFile(null);
      setCatalog(null);
      playSound('sent');
    });
  };

  const pickCatalog = (c: Catalog) => {
    if (!canWrite) {
      setNotice(mine ? 'No se puede escribirle a este cliente ahora.' : 'Toma la conversación para mandar catálogos.');
      return;
    }
    setNotice(null);
    setFile(null);
    setCatalog(c);
  };

  // Arrastrar al chat: un catálogo del estante o un archivo de la computadora.
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(CATALOG_DRAG_TYPE) || e.dataTransfer.types.includes('Files');
  const onDragOver = (e: DragEvent) => {
    if (!accepts(e) || needsTemplate || composerHint) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData(CATALOG_DRAG_TYPE);
    if (raw) {
      try {
        pickCatalog(JSON.parse(raw) as Catalog);
      } catch {
        /* arrastre de otra pestaña con datos raros: se ignora */
      }
      return;
    }
    if (e.dataTransfer.files[0]) {
      setCatalog(null);
      pickFile(e.dataTransfer.files[0]);
    }
  };

  const pickFile = (f: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    if (f.size > ATTACH_MAX_BYTES) {
      setNotice('El archivo pesa más de 16 MB. Comprímelo o mándalo por otro medio.');
      return;
    }
    setNotice(null);
    setCatalog(null);
    setFile(f);
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
  else if (metaChannel && !canWrite) composerHint = 'Pasaron más de 7 días desde el último mensaje del cliente: Meta no deja escribirle hasta que vuelva a escribir.';
  // Ventana cerrada en WhatsApp: el asesor escribe con una plantilla aprobada (TemplateComposer).
  const needsTemplate = mine && data.channel === 'whatsapp' && data.window.state !== 'FREE';
  const channelName = CHANNEL_LABELS[data.channel] ?? data.channel;

  return (
    <section
      className={`conversation ${dragOver ? 'drag-over' : ''}`}
      aria-label={`Conversación con ${data.contact.name}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <AnimatePresence>
        {dragOver && (
          <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true">
            <span>{Icon.catalog} Suelta aquí para mandarlo a {data.contact.name}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{shelfOpen && <CatalogShelf onPick={pickCatalog} onClose={() => setShelfOpen(false)} disabled={!canWrite} />}</AnimatePresence>
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
          <button
            className={`btn ghost ${shelfOpen ? 'on' : ''}`}
            type="button"
            onClick={() => setShelfOpen(!shelfOpen)}
            aria-pressed={shelfOpen}
            title="Catálogos para mandar al cliente"
          >
            {Icon.catalog} Catálogos
          </button>
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
            <span>Ventana de {channelName} abierta: quedan <b>{windowLeft}</b> para responder con texto libre.</span>
            <span className="window-bar" aria-hidden="true">
              <i style={{ width: `${Math.max(2, Math.min(100, ((new Date(data.window.expiresAt!).getTime() - Date.now()) / WINDOW_MS) * 100))}%` }} />
            </span>
          </>
        ) : data.window.state === 'HUMAN_AGENT_ONLY' ? (
          <span className="warn">Pasaron 24 h: el bot ya no puede escribir, pero tú sí puedes responder hasta 7 días después del último mensaje del cliente.</span>
        ) : (
          <span className="warn">Ventana de {metaChannel ? '7 días' : '24 h'} cerrada.</span>
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

      {needsTemplate ? (
        <TemplateComposer
          conversationId={id}
          contactName={data.contact.name}
          agentName={me.name}
          onSent={() => {
            setNotice('Plantilla enviada. Cuando el cliente responda, se abre otra vez la ventana para escribirle libre.');
            onChanged();
          }}
        />
      ) : (
      <form className="composer" onSubmit={send}>
        {composerHint ? (
          <p className="muted small hint">{composerHint}</p>
        ) : (
          <>
            <input ref={fileRef} type="file" accept={ATTACH_ACCEPT} hidden onChange={(e) => pickFile(e.target.files?.[0])} />
            <button
              className="icon-btn attach"
              type="button"
              disabled={busy || !canWrite}
              onClick={() => fileRef.current?.click()}
              aria-label="Adjuntar foto, video o documento"
              title="Adjuntar foto, video o documento"
            >
              {Icon.clip}
            </button>
            <div className="composer-body">
              {file && (
                <span className="chip attach-chip">
                  {Icon.file}
                  <span className="name">{file.name}</span>
                  <button type="button" onClick={() => setFile(null)} aria-label="Quitar el archivo">
                    {Icon.close}
                  </button>
                </span>
              )}
              {catalog && (
                <span className="chip attach-chip catalog">
                  {Icon.catalog}
                  <span className="name">Catálogo: {catalog.title}</span>
                  <button type="button" onClick={() => setCatalog(null)} aria-label="Quitar el catálogo">
                    {Icon.close}
                  </button>
                </span>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder={
                  catalog ? 'Texto que acompaña al catálogo (opcional)' : file ? 'Texto que acompaña al archivo (opcional)' : 'Escribe tu respuesta… (Enter envía, Shift+Enter nueva línea)'
                }
                maxLength={file || catalog ? 1024 : 4096}
                rows={2}
                aria-label="Respuesta al cliente"
              />
            </div>
            <motion.button
              className="btn primary"
              type="submit"
              disabled={busy || (!text.trim() && !file && !catalog) || !canWrite}
              whileTap={{ scale: 0.92 }}
              animate={{ opacity: text.trim() || file || catalog ? 1 : 0.55 }}
            >
              Enviar {Icon.send}
            </motion.button>
          </>
        )}
      </form>
      )}
    </section>
  );
}
