export interface TileFormat {
  pieceWidthCm: number;
  pieceLengthCm: number;
  /** m² que trae una caja. */
  areaPerBoxM2: number;
  piecesPerBox: number;
}

// "58.4x118.4/1.38m²/2 Piezas", "60x60/1.80m2/5 piezas", "29x118.4/1.37m/4 Piezas"…
const FORMAT_RE =
  /^\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*m(?:²|2)?\s*\/\s*(\d+)\s*piezas?\s*$/i;

const num = (s: string) => Number(s.replace(',', '.'));

/**
 * Lee el formato de venta de cerámicas y porcelanatos de la tienda. Devuelve `null` si el
 * texto no tiene esa forma (sanitarios, lavamanos o formatos vacíos), en vez de adivinar.
 */
export function parseTileFormat(fmt: string | null | undefined): TileFormat | null {
  if (!fmt) return null;
  const m = FORMAT_RE.exec(fmt);
  if (!m) return null;
  const [, w, l, area, pieces] = m as unknown as [string, string, string, string, string];
  const result = {
    pieceWidthCm: num(w),
    pieceLengthCm: num(l),
    areaPerBoxM2: num(area),
    piecesPerBox: Number(pieces),
  };
  const valid = Object.values(result).every((v) => Number.isFinite(v) && v > 0);
  return valid ? result : null;
}
