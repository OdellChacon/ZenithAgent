import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { formatBytes, type Catalog } from './api';
import { loadPdf, renderPage } from './pdf';
import { playSound } from './sounds';
import { Icon } from './ui';

const isPdf = (c: Catalog) => c.mimeType === 'application/pdf';

/** Ancho disponible de un elemento, al día cuando cambia el tamaño de la ventana. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Una página: se dibuja cuando se acerca a la vista, para no dibujar 80 páginas de golpe. */
function PdfPage({ doc, n, width, ratio }: { doc: PDFDocumentProxy; n: number; width: number; ratio: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<'idle' | 'ready' | 'error'>('idle');

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    // La raíz es la caja con scroll de la vista previa: así el margen adelanta las páginas siguientes.
    const io = new IntersectionObserver(([e]) => e!.isIntersecting && setVisible(true), { root: el.closest('.preview-body'), rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !width) return;
    const abort = new AbortController();
    renderPage(doc, n, width, abort.signal).then(
      (drawn) => {
        const target = canvas.current;
        if (abort.signal.aborted || !target) return;
        target.width = drawn.width;
        target.height = drawn.height;
        target.getContext('2d')?.drawImage(drawn, 0, 0);
        setState('ready');
      },
      () => !abort.signal.aborted && setState('error'),
    );
    return () => abort.abort();
  }, [doc, n, width, visible]);

  return (
    <div ref={holder} className={`pdf-page ${state}`} style={{ width, aspectRatio: String(ratio) }} aria-label={`Página ${n}`}>
      <canvas ref={canvas} />
      {state === 'error' && <span className="muted small">No se pudo dibujar la página {n}.</span>}
      <span className="pdf-page-n">{n}</span>
    </div>
  );
}

/** Todas las páginas del PDF, una debajo de otra. */
function PdfPages({ url, onPages }: { url: string; onPages: (n: number) => void }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [doc, setDoc] = useState<{ doc: PDFDocumentProxy; ratio: number } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    loadPdf(url)
      .then(async (d) => {
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        if (!alive) return;
        setDoc({ doc: d, ratio: first.width / first.height });
        onPages(d.numPages);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [url, onPages]);

  const pageWidth = Math.min(width, 860);
  return (
    <div ref={box} className="pdf-pages">
      {error && <p className="error">No se pudo abrir el PDF para la vista previa. Prueba con “Abrir en otra pestaña”.</p>}
      {!doc && !error && <p className="muted">Cargando el catálogo…</p>}
      {doc && pageWidth > 0 && Array.from({ length: doc.doc.numPages }, (_, i) => <PdfPage key={i} doc={doc.doc} n={i + 1} width={pageWidth} ratio={doc.ratio} />)}
    </div>
  );
}

/**
 * Vista previa de un catálogo sin salir del panel: el PDF página por página, la foto o el video.
 * De los documentos de Office no hay vista previa en el navegador: se ofrece descargarlos.
 */
export function CatalogPreview({ catalog, onClose, onPick, pickLabel = 'Adjuntar al chat' }: { catalog: Catalog | null; onClose: () => void; onPick?: (c: Catalog) => void; pickLabel?: string }) {
  const [pages, setPages] = useState<number | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  // Sonido al abrir y al cerrar (solo cuando cambia, no al montar el componente cerrado).
  const isOpen = catalog !== null;
  const wasOpen = useRef(isOpen);
  useEffect(() => {
    if (wasOpen.current === isOpen) return;
    wasOpen.current = isOpen;
    playSound(isOpen ? 'open' : 'close');
  }, [isOpen]);

  useEffect(() => {
    if (!catalog) return;
    setPages(null);
    const prev = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [catalog, onClose]);

  return createPortal(
    <AnimatePresence>
      {catalog && (
        <motion.div className="preview-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="preview-backdrop" onClick={onClose} />
          <motion.div
            className="preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Vista previa de ${catalog.title}`}
            initial={{ y: 18, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 18, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 36 }}
          >
            <header className="preview-head">
              <div className="preview-title">
                <b title={catalog.title}>{catalog.title}</b>
                <span className="muted small">
                  {catalog.filename} · {formatBytes(catalog.bytes)}
                  {pages !== null && ` · ${pages} ${pages === 1 ? 'página' : 'páginas'}`}
                </span>
              </div>
              <div className="preview-actions">
                {onPick && (
                  <button className="btn primary small" type="button" onClick={() => (onPick(catalog), onClose())}>
                    {pickLabel}
                  </button>
                )}
                <a className="btn small" href={catalog.url} target="_blank" rel="noopener noreferrer">
                  Abrir en otra pestaña
                </a>
                <button ref={close} className="icon-btn" type="button" onClick={onClose} aria-label="Cerrar vista previa">
                  {Icon.close}
                </button>
              </div>
            </header>
            <div className="preview-body">
              {isPdf(catalog) ? (
                <PdfPages url={catalog.url} onPages={setPages} />
              ) : catalog.mediaType === 'image' ? (
                <img className="preview-media" src={catalog.url} alt={catalog.title} />
              ) : catalog.mediaType === 'video' ? (
                <video className="preview-media" src={catalog.url} controls playsInline preload="metadata" />
              ) : (
                <div className="preview-none">
                  <span className="catalog-thumb-sheet">{Icon.file}</span>
                  <p>El navegador no puede mostrar este tipo de archivo.</p>
                  <a className="btn" href={catalog.url} download={catalog.filename}>
                    Descargar {catalog.filename}
                  </a>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
