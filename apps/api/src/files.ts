import type { Channel } from '@zenith/core';

/**
 * Archivos que un asesor manda desde el panel. Se guardan en la base de datos para reintentar
 * el envío y mostrarlos después, así que hay un tope propio de 16 MB aunque WhatsApp acepte
 * documentos de hasta 100 MB.
 */
export const AGENT_FILE_MAX_BYTES = 16 * 1024 * 1024;

const MB = 1024 * 1024;

const OFFICE_ZIP: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OFFICE_OLE: Record<string, string> = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

/** Marcas ("major brand") de la caja ftyp que son video MP4 (H.264/AAC en el caso normal). */
const MP4_BRANDS: ReadonlySet<string> = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash']);

/** Nombre seguro para guardar y mostrar: sin rutas ni caracteres de control. */
export function cleanFilename(name: string, fallback: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return base || fallback;
}

/**
 * Tipo real del archivo por su contenido (los primeros bytes), no por lo que dice el navegador.
 * Los documentos de Office se distinguen por la extensión porque por dentro son ZIP u OLE.
 */
export function sniffFile(data: Buffer, filename: string): { mimeType: string; filename: string } | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  const head = data.subarray(0, 16);
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  let mimeType: string | null = null;
  let defaultExt = ext;
  if (starts(0xff, 0xd8, 0xff)) [mimeType, defaultExt] = ['image/jpeg', 'jpg'];
  else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) [mimeType, defaultExt] = ['image/png', 'png'];
  else if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) [mimeType, defaultExt] = ['application/pdf', 'pdf'];
  else if (head.subarray(4, 8).toString('latin1') === 'ftyp') {
    // La caja "ftyp" la usan también .mov (qt), HEIC/HEIF y M4A: solo las marcas de MP4 y 3GP
    // son videos que WhatsApp, Messenger e Instagram aceptan.
    const brand = head.subarray(8, 12).toString('latin1');
    if (/^3g[p2]/.test(brand)) [mimeType, defaultExt] = ['video/3gpp', '3gp'];
    else if (MP4_BRANDS.has(brand)) [mimeType, defaultExt] = ['video/mp4', 'mp4'];
  } else if (starts(0x50, 0x4b, 0x03, 0x04) && OFFICE_ZIP[ext]) mimeType = OFFICE_ZIP[ext]!;
  else if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) && OFFICE_OLE[ext]) mimeType = OFFICE_OLE[ext]!;
  else if (ext === 'txt' && !data.subarray(0, 4096).includes(0)) mimeType = 'text/plain';
  if (!mimeType) return null;
  return { mimeType, filename: cleanFilename(filename, `archivo.${defaultExt || 'bin'}`) };
}

export interface AgentFileSpec {
  mediaType: 'image' | 'video' | 'document';
  maxBytes: number;
}

/**
 * Qué se puede mandar por cada canal, según Meta: WhatsApp acepta fotos de hasta 5 MB, videos de
 * 16 MB y documentos; Messenger e Instagram, fotos de hasta 8 MB y videos y archivos de 25 MB.
 * Encima de eso va el tope propio de 16 MB.
 */
export function agentFileSpec(channel: Channel, mimeType: string): AgentFileSpec | null {
  const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';
  const isVideo = mimeType === 'video/mp4' || mimeType === 'video/3gpp';
  if (channel === 'whatsapp') {
    if (isImage) return { mediaType: 'image', maxBytes: 5 * MB };
    if (isVideo) return { mediaType: 'video', maxBytes: 16 * MB };
    return { mediaType: 'document', maxBytes: AGENT_FILE_MAX_BYTES };
  }
  if (channel === 'messenger' || channel === 'instagram') {
    if (isImage) return { mediaType: 'image', maxBytes: 8 * MB };
    if (mimeType === 'video/mp4') return { mediaType: 'video', maxBytes: AGENT_FILE_MAX_BYTES };
    if (isVideo) return null;
    return { mediaType: 'document', maxBytes: AGENT_FILE_MAX_BYTES };
  }
  return null;
}

/** Los catálogos suelen ser PDF pesados: hasta 25 MB (lo máximo que aceptan Messenger e Instagram). */
export const CATALOG_MAX_BYTES = 25 * 1024 * 1024;

/** El límite por canal está en @zenith/core: también lo usa el bot. */
export { catalogSendLimit } from '@zenith/core';
