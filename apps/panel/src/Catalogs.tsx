import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen } from 'lucide-react';
import { api, ApiError, CATALOG_DRAG_TYPE, formatBytes, type Catalog } from './api';
import { CatalogPreview } from './CatalogPreview';
import { EmptyState } from './EmptyState';
import { ConfirmDialog, Modal } from './Modal';
import { forgetPdf, pdfCover } from './pdf';
import { playSound } from './sounds';
import { ago } from './time';
import { Icon } from './ui';

const CATALOG_ACCEPT = 'application/pdf,image/jpeg,image/png,video/mp4,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
const CATALOG_MAX_BYTES = 25 * 1024 * 1024;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 300;
const CATEGORY_MAX = 40;
const MESSAGE_MAX = 1000;

/** Familia del archivo, para el color de su insignia. */
function fileKind(ext: string): 'pdf' | 'image' | 'video' | 'doc' | 'sheet' | 'slides' | 'other' {
  const e = ext.toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(e)) return 'image';
  if (['mp4', '3gp'].includes(e)) return 'video';
  if (['doc', 'docx'].includes(e)) return 'doc';
  if (['xls', 'xlsx'].includes(e)) return 'sheet';
  if (['ppt', 'pptx'].includes(e)) return 'slides';
  return 'other';
}

/** Extensión para la insignia de la portada: PDF, XLSX, MP4… */
function extension(c: Catalog) {
  return (c.filename.split('.').pop() ?? c.mediaType).slice(0, 4).toUpperCase();
}

/** "Enviado 12 veces · último hace 2 horas" (cuenta asesores y bot). */
function usageText(c: Catalog): string {
  const { sent, byBot, lastSentAt } = c.usage;
  if (!sent) return 'Todavía no se ha enviado';
  const times = sent === 1 ? 'Enviado 1 vez' : `Enviado ${sent} veces`;
  const bot = byBot ? ` (${byBot} por el bot)` : '';
  return `${times}${bot}${lastSentAt ? ` · último ${ago(lastSentAt)}` : ''}`;
}

/** Sin tildes ni mayúsculas, para buscar "griferia" y encontrar "Grifería". */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('es');

/** Si el catálogo coincide con la búsqueda y la categoría elegida. */
function matches(c: Catalog, needle: string, category: string | null) {
  if (category && c.category !== category) return false;
  if (!needle) return true;
  return fold(`${c.title} ${c.description ?? ''} ${c.category ?? ''} ${c.filename}`).includes(fold(needle));
}

/** Se vuelve true cuando el elemento se acerca a la vista (para no dibujar portadas ocultas). */
function useNearView<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(([e]) => e!.isIntersecting && setNear(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near] as const;
}

/**
 * Portada del catálogo: la foto si es una imagen, la primera página si es un PDF y el primer
 * cuadro si es un video. Mientras carga (o si no se puede), una ficha con el tipo de archivo.
 */
export function CatalogThumb({ c, small = false }: { c: Catalog; small?: boolean }) {
  const [ref, near] = useNearView<HTMLSpanElement>();
  const [cover, setCover] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const pdf = c.mimeType === 'application/pdf';

  useEffect(() => {
    if (!pdf || !near) return;
    let alive = true;
    pdfCover(c.url).then(
      (src) => alive && setCover(src),
      () => alive && setFailed(true), // queda la ficha
    );
    return () => {
      alive = false;
    };
  }, [pdf, near, c.url]);

  const badge = (
    <b className="ext" data-kind={fileKind(extension(c))}>
      {extension(c)}
    </b>
  );
  return (
    <span
      ref={ref}
      className={`catalog-thumb ${small ? 'small' : ''} ${c.mediaType} ${cover ? 'has-cover' : ''} ${pdf && near && !cover && !failed ? 'loading' : ''}`}
      aria-hidden="true"
    >
      {c.mediaType === 'image' ? (
        <img src={c.url} alt="" loading="lazy" draggable={false} />
      ) : c.mediaType === 'video' && near ? (
        <>
          <video src={`${c.url}#t=0.5`} muted playsInline preload="metadata" tabIndex={-1} />
          {badge}
        </>
      ) : cover ? (
        <>
          <img className="page-cover" src={cover} alt="" draggable={false} />
          {badge}
        </>
      ) : (
        <>
          <span className="sheet">{c.mediaType === 'video' ? Icon.video : Icon.file}</span>
          {badge}
        </>
      )}
    </span>
  );
}

/** Datos que viajan al arrastrar un catálogo hasta un chat. */
export function startCatalogDrag(e: DragEvent, c: Catalog) {
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(CATALOG_DRAG_TYPE, JSON.stringify(c));
  e.dataTransfer.setData('text/plain', c.title);
}

// ------------------------------------------------------------------ campos compartidos

/** Categoría con sugerencias de las que ya existen (se puede escribir una nueva). */
function CategoryField({ value, onChange, categories, disabled, id }: { value: string; onChange: (v: string) => void; categories: string[]; disabled?: boolean; id: string }) {
  return (
    <label className="field">
      <span className="label">Categoría (opcional)</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={CATEGORY_MAX} list={id} disabled={disabled} placeholder="Ej.: Grifería" />
      <datalist id={id}>
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </label>
  );
}

/** Mensaje que se propone al mandar el catálogo a un chat. */
function MessageField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="field">
      <span className="label">Mensaje al enviarlo (opcional)</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MESSAGE_MAX}
        rows={2}
        disabled={disabled}
        placeholder="Ej.: Aquí tiene nuestro catálogo de grifería con los precios de noviembre."
      />
      <span className="counter">
        {value.length ? `${value.length}/${MESSAGE_MAX} · ` : ''}Aparece escrito al arrastrarlo a un chat; el asesor puede cambiarlo.
      </span>
    </label>
  );
}

/** Si el bot puede mandar este catálogo. Si el negocio no lo permite en general, se explica. */
function BotField({ value, onChange, botCanSend, disabled }: { value: boolean; onChange: (v: boolean) => void; botCanSend: boolean; disabled?: boolean }) {
  return (
    <label className={`bot-field ${botCanSend ? '' : 'off'}`}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className={`switch ${value ? 'on' : ''}`} aria-hidden="true" />
      <span>
        <b>El bot puede mandarlo</b>
        <span className="muted small">
          {botCanSend
            ? 'Lo manda cuando un cliente pide algo que este catálogo cubre. Apágalo para listas internas o con precios que debe dar un asesor.'
            : 'Por ahora el bot no manda catálogos: se activa arriba, en "El bot y los catálogos".'}
        </span>
      </span>
    </label>
  );
}

// ------------------------------------------------------------------ editar

/** Modal para cambiar nombre, descripción, categoría, mensaje y si el bot puede mandarlo. */
function CatalogEditModal({
  c,
  open,
  onClose,
  onSaved,
  categories,
  botCanSend,
}: {
  c: Catalog;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  categories: string[];
  botCanSend: boolean;
}) {
  const [title, setTitle] = useState(c.title);
  const [description, setDescription] = useState(c.description ?? '');
  const [category, setCategory] = useState(c.category ?? '');
  const [message, setMessage] = useState(c.defaultMessage ?? '');
  const [bot, setBot] = useState(c.botEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cada vez que se abre, parte de lo guardado.
  useEffect(() => {
    if (!open) return;
    setTitle(c.title);
    setDescription(c.description ?? '');
    setCategory(c.category ?? '');
    setMessage(c.defaultMessage ?? '');
    setBot(c.botEnabled);
    setError(null);
  }, [open, c.title, c.description, c.category, c.defaultMessage, c.botEnabled]);

  const cleanTitle = title.trim().replace(/\s+/g, ' ');
  const cleanDescription = description.trim();
  const cleanCategory = category.trim().replace(/\s+/g, ' ');
  const cleanMessage = message.trim();
  const changed =
    cleanTitle !== c.title ||
    cleanDescription !== (c.description ?? '') ||
    cleanCategory !== (c.category ?? '') ||
    cleanMessage !== (c.defaultMessage ?? '') ||
    bot !== c.botEnabled;
  const valid = cleanTitle.length > 0 && cleanTitle.length <= TITLE_MAX && cleanDescription.length <= DESCRIPTION_MAX;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !changed) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateCatalog(c.id, {
        title: cleanTitle,
        description: cleanDescription || null,
        category: cleanCategory || null,
        defaultMessage: cleanMessage || null,
        botEnabled: bot,
      });
      playSound('saved');
      onSaved();
      onClose();
    } catch (err) {
      playSound('error');
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title="Editar catálogo"
      description="Así lo ven los asesores en el panel. Al cliente le llega el archivo con su nombre original."
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn primary" type="submit" form={`catalog-edit-${c.id}`} disabled={busy || !valid || !changed}>
            {busy ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </>
      }
    >
      <form id={`catalog-edit-${c.id}`} className="catalog-edit-modal" onSubmit={save}>
        <div className="catalog-edit-file">
          <CatalogThumb c={c} />
          <span className="muted small" title={c.filename}>
            <span className="fname">{c.filename}</span>
            {extension(c)} · {formatBytes(c.bytes)}
            <span className="edit-usage">{usageText(c)}</span>
          </span>
        </div>
        <div className="catalog-edit-fields">
          <label className="field">
            <span className="label">Nombre</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} required aria-invalid={!cleanTitle} />
            <span className={`counter ${!cleanTitle ? 'bad' : ''}`}>{!cleanTitle ? 'El nombre no puede quedar vacío' : `${title.length}/${TITLE_MAX}`}</span>
          </label>
          <label className="field">
            <span className="label">Descripción (opcional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESCRIPTION_MAX}
              rows={2}
              placeholder="Ej.: porcelanatos tipo madera, precios de noviembre"
            />
            <span className="counter">
              {description.length}/{DESCRIPTION_MAX}
            </span>
          </label>
          <CategoryField value={category} onChange={setCategory} categories={categories} id={`cat-edit-${c.id}`} />
          <MessageField value={message} onChange={setMessage} />
          <BotField value={bot} onChange={setBot} botCanSend={botCanSend} />
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ tarjeta

function CatalogCard({
  c,
  canManage,
  onChanged,
  onPreview,
  categories,
  botCanSend,
  fresh = false,
}: {
  c: Catalog;
  canManage: boolean;
  onChanged: () => void;
  onPreview: (c: Catalog) => void;
  categories: string[];
  botCanSend: boolean;
  /** Recién subido: entra con una animación y queda resaltado unos segundos. */
  fresh?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const remove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      await api.deleteCatalog(c.id);
      forgetPdf(c.url);
      playSound('remove');
      setConfirming(false);
      onChanged();
    } catch (err) {
      playSound('error');
      setRemoveError(err instanceof ApiError ? err.message : 'No se pudo quitar. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      setRemoving(false);
    }
  };

  const botSends = botCanSend && c.botEnabled;
  return (
    <motion.li
      className={`card catalog-card ${fresh ? 'fresh' : ''}`}
      layout
      initial={fresh ? { opacity: 0, scale: 0.85, y: -16 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={fresh ? { type: 'spring', stiffness: 380, damping: 22 } : undefined}
    >
      {fresh && <span className="fresh-tag">Nuevo</span>}
      <button className="catalog-cover" type="button" onClick={() => onPreview(c)} aria-label={`Vista previa de ${c.title}`}>
        <CatalogThumb c={c} />
        <span className="cover-hint">{Icon.eye} Vista previa</span>
      </button>
      <div className="catalog-info">
        {(c.category || botSends) && (
          <span className="catalog-tags">
            {c.category && <span className="chip cat-chip">{c.category}</span>}
            {botSends && (
              <span className="chip bot-chip" title="El bot puede mandarlo cuando un cliente lo pida">
                {Icon.bot} Bot
              </span>
            )}
          </span>
        )}
        <b title={c.title}>{c.title}</b>
        {c.description && <p className="muted small">{c.description}</p>}
        <span className="muted small">
          {extension(c)} · {formatBytes(c.bytes)}
        </span>
        <span className={`catalog-usage small ${c.usage.sent ? '' : 'none'}`}>
          {Icon.send} {usageText(c)}
        </span>
        <div className="row-actions">
          <button className="btn small" type="button" onClick={() => onPreview(c)}>
            Vista previa
          </button>
          {canManage && (
            <>
              <button className="btn ghost small" type="button" onClick={() => setEditing(true)}>
                Editar
              </button>
              <button className="btn ghost small danger-text" type="button" onClick={() => (setRemoveError(null), setConfirming(true), playSound('warn'))}>
                Quitar
              </button>
            </>
          )}
        </div>
      </div>
      {canManage && (
        <>
          <CatalogEditModal c={c} open={editing} onClose={() => setEditing(false)} onSaved={onChanged} categories={categories} botCanSend={botCanSend} />
          <ConfirmDialog
            open={confirming}
            title="¿Quitar este catálogo?"
            message="Revisa que sea el correcto antes de continuar."
            item={
              <>
                <CatalogThumb c={c} small />
                <span>
                  <b title={c.title}>{c.title}</b>
                  <span className="muted small">
                    {extension(c)} · {formatBytes(c.bytes)}
                  </span>
                </span>
              </>
            }
            consequences={[
              { kind: 'lose', text: 'Deja de aparecer aquí y en el estante de catálogos de los chats.' },
              { kind: 'lose', text: 'Ni los asesores ni el bot podrán mandarlo. Para tenerlo otra vez hay que volver a subirlo.' },
              { kind: 'keep', text: 'Los chats donde ya se mandó lo siguen mostrando.' },
            ]}
            confirmLabel="Sí, quitar catálogo"
            busyLabel="Quitando…"
            busy={removing}
            error={removeError}
            onConfirm={remove}
            onCancel={() => (setConfirming(false), playSound('close'))}
          />
        </>
      )}
    </motion.li>
  );
}

// ------------------------------------------------------------------ subir

const CATALOG_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'mp4', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];

/** Vista previa del archivo elegido, antes de subirlo: la primera página, la foto o el video. */
function LocalFilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : ext === 'pdf' ? 'pdf' : 'other';

  useEffect(() => {
    if (kind === 'other') return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    setCover(null);
    let alive = true;
    if (kind === 'pdf')
      pdfCover(u).then(
        (src) => alive && setCover(src),
        () => undefined,
      );
    return () => {
      alive = false;
      forgetPdf(u);
      URL.revokeObjectURL(u);
    };
  }, [file, kind]);

  return (
    <span className={`catalog-thumb upload-thumb ${cover ? 'has-cover' : ''} ${kind === 'pdf' && !cover ? 'loading' : ''}`} aria-hidden="true">
      {kind === 'image' && url ? (
        <img src={url} alt="" />
      ) : kind === 'video' && url ? (
        <video src={`${url}#t=0.5`} muted playsInline preload="metadata" />
      ) : cover ? (
        <img className="page-cover" src={cover} alt="" />
      ) : (
        <span className="sheet">{Icon.file}</span>
      )}
      <b className="ext" data-kind={fileKind(ext)}>
        {ext.slice(0, 4).toUpperCase()}
      </b>
    </span>
  );
}

type UploadState =
  | { step: 'idle' }
  | { step: 'ready' }
  | { step: 'uploading'; loaded: number; total: number }
  | { step: 'duplicate'; existing: Catalog }
  | { step: 'done'; title: string };

/**
 * Caja para subir un catálogo: se arrastra el archivo encima o se elige con el botón; se ve
 * antes de subirlo, la subida muestra su avance (y se puede cancelar), avisa si ese mismo
 * archivo ya estaba subido y al terminar celebra con una animación y un sonido.
 */
function CatalogUpload({
  onUploaded,
  onPreview,
  categories,
  botCanSend,
}: {
  onUploaded: (item: Catalog) => void;
  onPreview: (c: Catalog) => void;
  categories: string[];
  botCanSend: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [bot, setBot] = useState(true);
  const [more, setMore] = useState(false);
  const [over, setOver] = useState(false);
  const [state, setState] = useState<UploadState>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const depth = useRef(0); // dragenter/dragleave también saltan al pasar sobre los hijos

  useEffect(() => () => abort.current?.abort(), []);

  const fail = (msg: string) => {
    setError(msg);
    playSound('error');
  };

  const clearFields = () => {
    setTitle('');
    setDescription('');
    setCategory('');
    setMessage('');
    setBot(true);
    setMore(false);
  };

  const choose = (f: File | undefined) => {
    if (!f) return;
    setError(null);
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    if (!CATALOG_EXTENSIONS.includes(ext))
      return fail('Ese tipo de archivo no se puede mandar como catálogo. Sube un PDF, una foto (JPG o PNG), un video MP4 o un documento de Office.');
    if (!f.size) return fail('El archivo está vacío.');
    if (f.size > CATALOG_MAX_BYTES) return fail(`El archivo pesa ${formatBytes(f.size)} y el máximo es 25 MB. Comprímelo antes de subirlo.`);
    setFile(f);
    clearFields();
    setTitle(
      f.name
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TITLE_MAX),
    );
    setState({ step: 'ready' });
    playSound('tap');
  };

  const reset = () => {
    setFile(null);
    clearFields();
    setError(null);
    setState({ step: 'idle' });
  };

  const cleanTitle = title.trim().replace(/\s+/g, ' ');
  const uploading = state.step === 'uploading';

  const upload = async (allowDuplicate = false) => {
    if (!file || !cleanTitle || uploading) return;
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ step: 'uploading', loaded: 0, total: file.size });
    try {
      const { item } = await api.uploadCatalog(
        file,
        { title: cleanTitle, description, category, defaultMessage: message, botEnabled: bot, allowDuplicate },
        { signal: ctrl.signal, onProgress: (p) => setState({ step: 'uploading', loaded: p.loaded, total: p.total }) },
      );
      playSound('uploaded');
      setState({ step: 'done', title: item.title });
      onUploaded(item);
      window.setTimeout(() => {
        setFile(null);
        clearFields();
        setState((s) => (s.step === 'done' ? { step: 'idle' } : s));
      }, 1800);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'aborted') {
        setState({ step: 'ready' });
        playSound('close');
        return;
      }
      if (err instanceof ApiError && err.code === 'duplicate' && err.details?.existing) {
        setState({ step: 'duplicate', existing: err.details.existing as Catalog });
        playSound('warn');
        return;
      }
      setState({ step: 'ready' });
      fail(err instanceof ApiError ? err.message : 'No se pudo subir el catálogo.');
    } finally {
      abort.current = null;
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void upload();
  };

  const pct = state.step === 'uploading' && state.total ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : 0;

  return (
    <form className={`card catalog-upload ${state.step}`} onSubmit={submit}>
      <input ref={input} type="file" accept={CATALOG_ACCEPT} hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ''))} />
      <AnimatePresence mode="wait" initial={false}>
        {state.step === 'done' ? (
          <motion.div
            key="done"
            className="upload-done"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            role="status"
          >
            <span className="done-burst" aria-hidden="true">
              {Array.from({ length: 10 }, (_, i) => (
                <i key={i} style={{ ['--a' as string]: `${i * 36}deg` }} />
              ))}
            </span>
            <motion.span className="done-check" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 520, damping: 18 }}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <motion.path
                  d="M5 12.5l4.5 4.5L19 7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: 0.15, duration: 0.35 }}
                />
              </svg>
            </motion.span>
            <b>Catálogo subido</b>
            <span className="muted small">“{state.title}” ya está disponible para los asesores.</span>
          </motion.div>
        ) : state.step === 'duplicate' ? (
          <motion.div key="dup" className="upload-dup" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="alert">
            <span className="dup-thumb">
              <CatalogThumb c={state.existing} small />
            </span>
            <span className="dup-text">
              <b>Este archivo ya está subido</b>
              <span className="muted small">
                Es el mismo que “{state.existing.title}”. Subirlo de nuevo crea un catálogo repetido para los asesores.
              </span>
            </span>
            <span className="dup-actions">
              <button className="btn small" type="button" onClick={() => onPreview(state.existing)}>
                Ver el existente
              </button>
              <button className="btn ghost small" type="button" onClick={() => void upload(true)}>
                Subir igual
              </button>
              <button className="btn ghost small danger-text" type="button" onClick={() => (reset(), playSound('close'))}>
                Descartar
              </button>
            </span>
          </motion.div>
        ) : !file ? (
          <motion.div key="drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div
              className={`dropzone ${over ? 'over' : ''}`}
              onClick={() => input.current?.click()}
              onDragEnter={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                depth.current++;
                setOver(true);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDragLeave={() => {
                depth.current = Math.max(0, depth.current - 1);
                if (!depth.current) setOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                depth.current = 0;
                setOver(false);
                choose(e.dataTransfer.files[0]);
              }}
            >
              <span className="dz-badge">{Icon.upload}</span>
              <span className="dz-text">
                <b>{over ? 'Suelta el archivo para subirlo' : 'Arrastra aquí el catálogo'}</b>
                <span className="muted small">PDF, foto (JPG o PNG), video MP4 o documento de Office · hasta 25 MB</span>
              </span>
              <button className="btn small" type="button" onClick={(e) => (e.stopPropagation(), input.current?.click())}>
                Elegir archivo
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="file" className="upload-file" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <LocalFilePreview file={file} />
            <div className="upload-main">
              <div className="upload-file-head">
                <span className="upload-file-name">
                  <b title={file.name}>{file.name}</b>
                  <span className="muted small">{formatBytes(file.size)}</span>
                </span>
                {!uploading && (
                  <span className="upload-file-actions">
                    <button className="btn ghost small" type="button" onClick={() => input.current?.click()}>
                      Cambiar
                    </button>
                    <button className="btn ghost small danger-text" type="button" onClick={() => (reset(), playSound('close'))}>
                      Descartar
                    </button>
                  </span>
                )}
              </div>
              <div className="upload-fields">
                <label className="field">
                  <span className="label">Nombre</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} required disabled={uploading} aria-invalid={!cleanTitle} />
                  <span className={`counter ${!cleanTitle ? 'bad' : ''}`}>{!cleanTitle ? 'Ponle un nombre al catálogo' : `${title.length}/${TITLE_MAX}`}</span>
                </label>
                <CategoryField value={category} onChange={setCategory} categories={categories} disabled={uploading} id="cat-upload" />
                <label className="field span-2">
                  <span className="label">Descripción (opcional)</span>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={DESCRIPTION_MAX}
                    disabled={uploading}
                    placeholder="Ej.: porcelanatos tipo madera, precios de noviembre"
                  />
                  <span className="counter">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </label>
              </div>
              <button className="more-toggle" type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}>
                <span className={`chev ${more ? 'open' : ''}`} aria-hidden="true">
                  {Icon.chevron}
                </span>
                Mensaje al enviarlo y bot
              </button>
              <AnimatePresence initial={false}>
                {more && (
                  <motion.div className="upload-more" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                    <MessageField value={message} onChange={setMessage} disabled={uploading} />
                    <BotField value={bot} onChange={setBot} botCanSend={botCanSend} disabled={uploading} />
                  </motion.div>
                )}
              </AnimatePresence>
              {uploading ? (
                <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Subiendo el catálogo">
                  <div className="bar">
                    <motion.span animate={{ width: `${pct}%` }} transition={{ ease: 'easeOut', duration: 0.25 }} />
                  </div>
                  <span className="small">
                    {pct < 100 ? `Subiendo… ${pct}% · ${formatBytes(state.loaded)} de ${formatBytes(state.total)}` : 'Procesando el archivo…'}
                  </span>
                  <button className="btn ghost small" type="button" onClick={() => abort.current?.abort()} disabled={pct >= 100}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <div className="upload-submit">
                  <button className="btn primary" type="submit" disabled={!cleanTitle}>
                    {Icon.upload} Subir catálogo
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {error && (
          <motion.p
            className="confirm-error"
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, x: [0, -6, 6, -3, 3, 0] }}
            exit={{ opacity: 0 }}
          >
            {Icon.alert} {error}
          </motion.p>
        )}
      </AnimatePresence>
    </form>
  );
}

// ------------------------------------------------------------------ bot

/** Interruptor general: si el bot puede mandar catálogos por su cuenta. */
function BotSetting({ value, canManage, count, onChange }: { value: boolean; canManage: boolean; count: number; onChange: (v: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.setCatalogBot(next);
      onChange(next);
      playSound(next ? 'saved' : 'close');
    } catch (err) {
      playSound('error');
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`card bot-setting ${value ? 'on' : ''}`}>
      <span className="bot-setting-icon" aria-hidden="true">
        {Icon.bot}
      </span>
      <span className="bot-setting-text">
        <b>El bot y los catálogos</b>
        <span className="muted small">
          {value
            ? `El bot manda el catálogo que corresponda cuando un cliente lo pide (${count} ${count === 1 ? 'habilitado' : 'habilitados'}). En cada catálogo puedes impedir que lo mande.`
            : 'Hoy solo los asesores mandan catálogos. Si lo activas, el bot manda el que corresponda cuando un cliente pida un catálogo o una lista de productos.'}
        </span>
        {error && <span className="error small">{error}</span>}
      </span>
      {canManage ? (
        <label className="bot-setting-switch">
          <input type="checkbox" checked={value} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          <span className={`switch big ${value ? 'on' : ''}`} aria-hidden="true" />
          <span className="sr-only">Permitir que el bot mande catálogos</span>
        </label>
      ) : (
        <span className={`chip ${value ? 'ok' : 'muted-chip'}`}>{value ? 'Activado' : 'Desactivado'}</span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ filtros

/** Búsqueda y categorías, para la página y el estante del chat. */
function CatalogFilters({
  q,
  onQ,
  category,
  onCategory,
  categories,
  compact = false,
}: {
  q: string;
  onQ: (v: string) => void;
  category: string | null;
  onCategory: (v: string | null) => void;
  categories: string[];
  compact?: boolean;
}) {
  return (
    <div className={`catalog-filters ${compact ? 'compact' : ''}`}>
      <span className="search-box">
        {Icon.search}
        <input className="search" value={q} onChange={(e) => onQ(e.target.value)} placeholder="Buscar por nombre, descripción o categoría" aria-label="Buscar catálogo" />
        {q && (
          <button type="button" className="icon-btn" onClick={() => onQ('')} aria-label="Borrar la búsqueda">
            {Icon.close}
          </button>
        )}
      </span>
      {categories.length > 0 && (
        <span className="cat-filter" role="group" aria-label="Filtrar por categoría">
          <button type="button" className={`chip tag ${category === null ? 'on' : ''}`} onClick={() => onCategory(null)} aria-pressed={category === null}>
            Todas
          </button>
          {categories.map((c) => (
            <button key={c} type="button" className={`chip tag ${category === c ? 'on' : ''}`} onClick={() => onCategory(category === c ? null : c)} aria-pressed={category === c}>
              {c}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ página

type CatalogData = { items: Catalog[]; categories: string[]; canManage: boolean; botCanSend: boolean };

/** Sección "Catálogos": los ve todo el equipo; los sube y edita el dueño o un administrador. */
export function Catalogs({ tick }: { tick: number }) {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<Catalog | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    if (!freshId) return;
    const t = window.setTimeout(() => setFreshId(null), 6000);
    return () => window.clearTimeout(t);
  }, [freshId]);

  useEffect(() => {
    let alive = true;
    api
      .catalogs()
      .then((d) => alive && (setData(d), setError(null)))
      .catch(() => alive && setError('No se pudieron cargar los catálogos.'));
    return () => {
      alive = false;
    };
  }, [tick, reload]);

  // Si se quitó la última de una categoría, el filtro vuelve a "Todas".
  useEffect(() => {
    if (category && data && !data.categories.includes(category)) setCategory(null);
  }, [data, category]);

  const refresh = () => setReload((r) => r + 1);
  const shown = (data?.items ?? []).filter((c) => matches(c, q.trim(), category));

  return (
    <section className="catalogs-page">
      <div className="page-head">
        <h2>Catálogos</h2>
        <p className="muted">
          Los catálogos de productos para mandar a los clientes. En una conversación, abre <b>Catálogos</b> y arrastra el que quieras al chat.
        </p>
      </div>
      {data && (data.canManage || data.botCanSend) && (
        <BotSetting
          value={data.botCanSend}
          canManage={data.canManage}
          count={data.items.filter((c) => c.botEnabled).length}
          onChange={(v) => setData((d) => (d ? { ...d, botCanSend: v } : d))}
        />
      )}
      {data?.canManage && (
        <CatalogUpload
          categories={data.categories}
          botCanSend={data.botCanSend}
          onPreview={setPreview}
          onUploaded={(item) => {
            setFreshId(item.id);
            setQ('');
            setCategory(null);
            // Aparece de inmediato; la lista del servidor confirma después.
            setData((d) => (d && !d.items.some((x) => x.id === item.id) ? { ...d, items: [item, ...d.items] } : d));
            refresh();
          }}
        />
      )}
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Cargando…</p>}
      {data && !data.items.length && (
        <EmptyState
          icon={BookOpen}
          tone="accent"
          title="Todavía no hay catálogos"
          text={data.canManage ? 'Sube el primero arrastrando el PDF a la caja de arriba.' : 'Pídele al administrador que suba los catálogos de productos.'}
        />
      )}
      {data && data.items.length > 0 && (
        <>
          {(data.items.length > 3 || data.categories.length > 0) && (
            <CatalogFilters q={q} onQ={setQ} category={category} onCategory={setCategory} categories={data.categories} />
          )}
          {!shown.length && (
            <p className="muted catalog-none">
              Ningún catálogo coincide{q.trim() ? ` con “${q.trim()}”` : ''}
              {category ? ` en ${category}` : ''}.{' '}
              <button type="button" className="link-btn" onClick={() => (setQ(''), setCategory(null))}>
                Ver todos
              </button>
            </p>
          )}
          <ul className="catalog-grid">
            <AnimatePresence initial={false}>
              {shown.map((c) => (
                <CatalogCard
                  key={c.id}
                  c={c}
                  canManage={data.canManage}
                  onChanged={refresh}
                  onPreview={setPreview}
                  categories={data.categories}
                  botCanSend={data.botCanSend}
                  fresh={c.id === freshId}
                />
              ))}
            </AnimatePresence>
          </ul>
        </>
      )}
      <CatalogPreview catalog={preview} onClose={closePreview} />
    </section>
  );
}

// ------------------------------------------------------------------ estante del chat

/**
 * Estante de catálogos dentro de una conversación. Cada catálogo se arrastra al chat (o se
 * toca "Adjuntar") y queda listo en la caja de respuesta, con su mensaje predeterminado.
 */
export function CatalogShelf({
  onPick,
  onClose,
  blockedReason,
}: {
  onPick: (c: Catalog) => void;
  onClose: () => void;
  /** Por qué no se puede mandar nada ahora (sin tomar la conversación, ventana cerrada…); null si se puede. */
  blockedReason: string | null;
}) {
  const disabled = blockedReason !== null;
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [preview, setPreview] = useState<Catalog | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);

  useEffect(() => {
    let alive = true;
    api
      .catalogs()
      .then((d) => alive && setData(d))
      .catch(() => alive && setError('No se pudieron cargar los catálogos.'));
    return () => {
      alive = false;
    };
  }, []);

  const items = data?.items ?? null;
  const shown = (items ?? []).filter((c) => matches(c, q.trim(), category));

  return (
    <motion.aside
      className="catalog-shelf"
      aria-label="Catálogos para compartir"
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
    >
      <div className="shelf-head">
        <b>Catálogos</b>
        <button className="icon-btn" type="button" onClick={onClose} aria-label="Cerrar catálogos">
          {Icon.close}
        </button>
      </div>
      <p className="muted small">{blockedReason ?? 'Arrastra un catálogo al chat o toca Adjuntar.'}</p>
      {items && (items.length > 4 || (data?.categories.length ?? 0) > 0) && (
        <CatalogFilters q={q} onQ={setQ} category={category} onCategory={setCategory} categories={data?.categories ?? []} compact />
      )}
      {error && <p className="error small">{error}</p>}
      {!items && !error && <p className="muted small">Cargando…</p>}
      {items && !items.length && <p className="muted small">No hay catálogos. El administrador los sube en la sección Catálogos.</p>}
      {items && items.length > 0 && !shown.length && <p className="muted small">Ningún catálogo coincide.</p>}
      <ul className="shelf-list">
        {shown.map((c) => (
          <li
            key={c.id}
            className={`shelf-item ${disabled ? 'off' : ''}`}
            draggable={!disabled}
            onDragStart={(e) => startCatalogDrag(e, c)}
            title={disabled ? undefined : 'Arrástralo al chat'}
          >
            <button className="shelf-thumb" type="button" onClick={() => setPreview(c)} aria-label={`Vista previa de ${c.title}`} title="Vista previa">
              <CatalogThumb c={c} small />
            </button>
            <span className="shelf-text">
              <b>{c.title}</b>
              <span className="muted small">
                {[c.category, extension(c), formatBytes(c.bytes)].filter(Boolean).join(' · ')}
              </span>
              <span className="shelf-usage small">{usageText(c)}</span>
            </span>
            <button className="btn small" type="button" disabled={disabled} onClick={() => onPick(c)}>
              Adjuntar
            </button>
          </li>
        ))}
      </ul>
      <CatalogPreview catalog={preview} onClose={closePreview} {...(disabled ? {} : { onPick })} />
    </motion.aside>
  );
}
