import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen } from 'lucide-react';
import { api, ApiError, CATALOG_DRAG_TYPE, formatBytes, type Catalog } from './api';
import { EmptyState } from './EmptyState';
import { Icon } from './ui';

const CATALOG_ACCEPT = 'application/pdf,image/jpeg,image/png,video/mp4,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
const CATALOG_MAX_BYTES = 25 * 1024 * 1024;

/** Extensión para la insignia de la portada: PDF, XLSX, MP4… */
function extension(c: Catalog) {
  return (c.filename.split('.').pop() ?? c.mediaType).slice(0, 4).toUpperCase();
}

/** Portada del catálogo: la foto si es una imagen; si no, una ficha con el tipo de archivo. */
export function CatalogThumb({ c, small = false }: { c: Catalog; small?: boolean }) {
  return (
    <span className={`catalog-thumb ${small ? 'small' : ''} ${c.mediaType}`} aria-hidden="true">
      {c.mediaType === 'image' ? (
        <img src={c.url} alt="" loading="lazy" draggable={false} />
      ) : (
        <>
          <span className="sheet">{c.mediaType === 'video' ? Icon.video : Icon.file}</span>
          <b className="ext">{extension(c)}</b>
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

function CatalogCard({ c, canManage, onChanged }: { c: Catalog; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [description, setDescription] = useState(c.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateCatalog(c.id, { title, description: description.trim() || null });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`¿Quitar "${c.title}" de los catálogos? Los chats donde ya se mandó lo seguirán mostrando.`)) return;
    setBusy(true);
    try {
      await api.deleteCatalog(c.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo quitar.');
      setBusy(false);
    }
  };

  return (
    <motion.li className="card catalog-card" layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
      <a className="catalog-cover" href={c.url} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${c.title}`}>
        <CatalogThumb c={c} />
      </a>
      {editing ? (
        <form className="catalog-edit" onSubmit={save}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required aria-label="Nombre del catálogo" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={2} placeholder="Descripción (opcional)" aria-label="Descripción" />
          <div className="row-actions">
            <button className="btn primary small" type="submit" disabled={busy || !title.trim()}>
              Guardar
            </button>
            <button className="btn ghost small" type="button" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="catalog-info">
          <b title={c.title}>{c.title}</b>
          {c.description && <p className="muted small">{c.description}</p>}
          <span className="muted small">
            {extension(c)} · {formatBytes(c.bytes)}
          </span>
          <div className="row-actions">
            <a className="btn small" href={c.url} target="_blank" rel="noopener noreferrer">
              Abrir
            </a>
            {canManage && (
              <>
                <button className="btn ghost small" type="button" onClick={() => setEditing(true)} disabled={busy}>
                  Editar
                </button>
                <button className="btn small danger-btn" type="button" onClick={remove} disabled={busy}>
                  Quitar
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </motion.li>
  );
}

/** Caja para subir un catálogo: se arrastra el archivo encima o se elige con el botón. */
function CatalogUpload({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const choose = (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (f.size > CATALOG_MAX_BYTES) {
      setError('El catálogo pesa más de 25 MB. Comprime el PDF antes de subirlo.');
      return;
    }
    setFile(f);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 120));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadCatalog(file, title, description);
      setFile(null);
      setTitle('');
      setDescription('');
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo subir el catálogo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card catalog-upload" onSubmit={submit}>
      <div
        className={`dropzone ${over ? 'over' : ''} ${file ? 'has-file' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        <input ref={input} type="file" accept={CATALOG_ACCEPT} hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ''))} />
        <span className="dz-icon">{Icon.upload}</span>
        {file ? (
          <span>
            <b>{file.name}</b> · {formatBytes(file.size)}
          </span>
        ) : (
          <span>Arrastra aquí el PDF del catálogo o</span>
        )}
        <button className="btn small" type="button" onClick={() => input.current?.click()}>
          {file ? 'Cambiar archivo' : 'Elegir archivo'}
        </button>
      </div>
      {file && (
        <div className="catalog-upload-fields">
          <label className="field">
            <span className="label">Nombre</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
          </label>
          <label className="field">
            <span className="label">Descripción (opcional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Ej.: porcelanatos tipo madera, precios de noviembre" />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !title.trim()}>
            {busy ? 'Subiendo…' : 'Subir catálogo'}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** Sección "Catálogos": los ve todo el equipo; los sube y edita el dueño o un administrador. */
export function Catalogs({ tick }: { tick: number }) {
  const [data, setData] = useState<{ items: Catalog[]; canManage: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

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

  const refresh = () => setReload((r) => r + 1);

  return (
    <section className="catalogs-page">
      <div className="page-head">
        <h2>Catálogos</h2>
        <p className="muted">
          Los catálogos de productos para mandar a los clientes. En una conversación, abre <b>Catálogos</b> y arrastra el que quieras al chat.
        </p>
      </div>
      {data?.canManage && <CatalogUpload onUploaded={refresh} />}
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
        <ul className="catalog-grid">
          <AnimatePresence initial={false}>
            {data.items.map((c) => (
              <CatalogCard key={c.id} c={c} canManage={data.canManage} onChanged={refresh} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

/**
 * Estante de catálogos dentro de una conversación. Cada catálogo se arrastra al chat (o se
 * toca "Adjuntar") y queda listo en la caja de respuesta para mandarlo con un texto opcional.
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
  const [items, setItems] = useState<Catalog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .catalogs()
      .then((d) => alive && setItems(d.items))
      .catch(() => alive && setError('No se pudieron cargar los catálogos.'));
    return () => {
      alive = false;
    };
  }, []);

  const needle = q.trim().toLocaleLowerCase('es');
  const shown = (items ?? []).filter((c) => !needle || `${c.title} ${c.description ?? ''}`.toLocaleLowerCase('es').includes(needle));

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
      {items && items.length > 4 && <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar catálogo" aria-label="Buscar catálogo" />}
      {error && <p className="error small">{error}</p>}
      {!items && !error && <p className="muted small">Cargando…</p>}
      {items && !items.length && <p className="muted small">No hay catálogos. El administrador los sube en la sección Catálogos.</p>}
      <ul className="shelf-list">
        {shown.map((c) => (
          <li
            key={c.id}
            className={`shelf-item ${disabled ? 'off' : ''}`}
            draggable={!disabled}
            onDragStart={(e) => startCatalogDrag(e, c)}
            title={disabled ? undefined : 'Arrástralo al chat'}
          >
            <CatalogThumb c={c} small />
            <span className="shelf-text">
              <b>{c.title}</b>
              <span className="muted small">
                {extension(c)} · {formatBytes(c.bytes)}
              </span>
            </span>
            <button className="btn small" type="button" disabled={disabled} onClick={() => onPick(c)}>
              Adjuntar
            </button>
          </li>
        ))}
      </ul>
    </motion.aside>
  );
}
