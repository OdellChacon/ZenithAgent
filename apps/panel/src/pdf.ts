/**
 * Dibuja páginas de un PDF en el navegador con pdf.js, para la portada y la vista previa de los
 * catálogos. pdf.js se carga solo la primera vez que hace falta (no pesa en el resto del panel)
 * y cada PDF se descarga una sola vez por sesión.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let lib: Promise<typeof import('pdfjs-dist')> | null = null;
function pdfjs() {
  lib ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return lib;
}

const docs = new Map<string, Promise<PDFDocumentProxy>>();

/** Abre el PDF (una vez por url). Sin eval ni scripts del documento: solo se dibuja. */
export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let doc = docs.get(url);
  if (!doc) {
    doc = pdfjs().then((m) => m.getDocument({ url, withCredentials: true, isEvalSupported: false, enableXfa: false }).promise);
    doc.catch(() => docs.delete(url)); // si falla, el siguiente intento vuelve a probar
    docs.set(url, doc);
  }
  return doc;
}

/**
 * Dibuja una página (desde 1) al ancho pedido, en píxeles CSS, nítida en pantallas de alta
 * densidad. Cada dibujo usa un canvas nuevo (pdf.js no deja dibujar dos veces a la vez en el
 * mismo) y se cancela con `signal` si ya no hace falta.
 */
export async function renderPage(doc: PDFDocumentProxy, pageNumber: number, cssWidth: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  signal?.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  return canvas;
}

const covers = new Map<string, Promise<string>>();

/** Imagen de la primera página, para la portada (una vez por url). */
export function pdfCover(url: string, cssWidth = 260): Promise<string> {
  let cover = covers.get(url);
  if (!cover) {
    cover = loadPdf(url).then(async (doc) => {
      const canvas = await renderPage(doc, 1, cssWidth);
      return canvas.toDataURL('image/jpeg', 0.82);
    });
    cover.catch(() => covers.delete(url));
    covers.set(url, cover);
  }
  return cover;
}

/** Al cambiar o quitar un catálogo, se olvida lo guardado de su archivo. */
export function forgetPdf(url: string) {
  void docs.get(url)?.then((d) => d.destroy()).catch(() => undefined);
  docs.delete(url);
  covers.delete(url);
}
