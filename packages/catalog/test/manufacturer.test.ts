import { describe, expect, it } from 'vitest';
import { canonicalDesign, enrichWithManufacturer, matchManufacturer, type ManufacturerProduct, type ProductInput } from '../src/index.js';

const tile = (name: string, w: number | null, l: number | null, extra: Partial<ProductInput> = {}): ProductInput => ({
  externalId: name,
  name,
  category: 'ceranattos',
  categoryName: 'Ceranattos',
  description: null,
  format: null,
  pieceWidthCm: w,
  pieceLengthCm: l,
  areaPerBoxM2: 1.37,
  piecesPerBox: 4,
  attributes: { finish: 'Mate' },
  price: null,
  currency: null,
  onOffer: false,
  inVisualizer: true,
  ...extra,
});

const catalog: ManufacturerProduct[] = [
  { ref: '231125', nombre: 'Ceranatto Ocrea 29X118.4 Cyr', diseno: ['Madera'], color: 'Café', coleccion: 'Ceranatto', trafico: 'Comercial General', pei: '4', ancho_cm: 29, largo_cm: 118.4 },
  { ref: '1', nombre: 'Ceranatto Sinai 58.4X118.4', diseno: ['Marmolizados'], color: 'Blanco', ancho_cm: 58.4, largo_cm: 118.4 },
  { ref: '2', nombre: 'Piso Sinai 60X60', diseno: ['Cemento'], color: 'Gris', ancho_cm: 60, largo_cm: 60 },
  { ref: '3', nombre: 'Piso Itria Beige 60X60', diseno: ['Natural'], color: 'Beige', ancho_cm: 60, largo_cm: 60 },
  { ref: '4', nombre: 'Piso Itria Gris 60X60', diseno: ['Cemento'], color: 'Gris', ancho_cm: 60, largo_cm: 60 },
  { ref: '5', nombre: 'Piso Exterior Medellin 60X60', diseno: ['Natural'], color: 'Gris', precio_m2: 74800 } as ManufacturerProduct,
];

describe('canonicalDesign', () => {
  it('unifica las distintas formas de escribir el diseño', () => {
    expect(canonicalDesign(['Marmolizados', 'Marmol', 'Marmolizado'])).toEqual(['Mármol']);
    expect(canonicalDesign(['Naturales'])).toEqual(['Piedra natural']);
    expect(canonicalDesign(['Planos y Lisos', 'Acentos/decorados'])).toEqual(['Liso', 'Decorado']);
  });
});

describe('matchManufacturer', () => {
  it('empareja por nombre del modelo', () => {
    expect(matchManufacturer(tile('Ocrea Dual', 29, 118.4), catalog)?.ref).toBe('231125');
  });

  it('desempata por medidas cuando el nombre se repite', () => {
    expect(matchManufacturer(tile('Sinai', 58.4, 118.4), catalog)?.ref).toBe('1');
    expect(matchManufacturer(tile('Sinai', 60, 60), catalog)?.ref).toBe('2');
  });

  it('no adivina si hay candidatos distintos que no se pueden separar', () => {
    expect(matchManufacturer(tile('Itria', 60, 60), catalog)).toBeNull();
  });

  it('ignora lo que no es cerámica', () => {
    expect(matchManufacturer(tile('Ocrea Dual', 29, 118.4, { category: 'sanitarios' }), catalog)).toBeNull();
  });
});

describe('enrichWithManufacturer', () => {
  it('agrega aspecto, color y colección sin pisar los datos de la tienda ni copiar precios', () => {
    const { products, matched, unmatched } = enrichWithManufacturer(
      [tile('Ocrea Dual', 29, 118.4), tile('Desconocido', 60, 60), tile('Exterior Medellin Gris', 60, 60, { attributes: { color: 'Gris tienda' } })],
      catalog,
    );
    expect(matched).toBe(2);
    expect(unmatched).toEqual(['Desconocido']);
    expect(products[0]!.attributes).toEqual({
      manufacturer_ref: '231125',
      design: ['Madera'],
      color: 'Café',
      collection: 'Ceranatto',
      traffic: 'Comercial General',
      pei: '4',
      finish: 'Mate',
    });
    expect(products[2]!.attributes.color).toBe('Gris tienda');
    expect(JSON.stringify(products)).not.toContain('74800');
    expect(products[0]!.price).toBeNull();
  });
});
