export interface BoxCalculation {
  boxes: number;
  /** m² que cubren las cajas calculadas. */
  coveredM2: number;
  pieces: number | null;
  /** % aplicado; null si el negocio no lo definió (se calcula sin desperdicio). */
  wastePercent: number | null;
}

/**
 * Cajas necesarias para cubrir `areaM2`. Se redondea hacia arriba: siempre se venden cajas
 * completas. El desperdicio lo define el negocio; mientras no esté, no se agrega.
 */
export function calculateBoxes(
  areaM2: number,
  areaPerBoxM2: number,
  piecesPerBox: number | null,
  wastePercent: number | null,
): BoxCalculation {
  if (!(areaM2 > 0) || !Number.isFinite(areaM2)) throw new RangeError('Los metros cuadrados deben ser mayores que 0');
  if (!(areaPerBoxM2 > 0)) throw new RangeError('El producto no tiene m² por caja');
  const waste = wastePercent ?? 0;
  const needed = areaM2 * (1 + waste / 100);
  // Se redondea a milésimas antes del techo para no sumar una caja por error de coma flotante.
  const boxes = Math.ceil(Math.round((needed / areaPerBoxM2) * 1000) / 1000);
  return {
    boxes,
    coveredM2: Math.round(boxes * areaPerBoxM2 * 100) / 100,
    pieces: piecesPerBox ? boxes * piecesPerBox : null,
    wastePercent,
  };
}
