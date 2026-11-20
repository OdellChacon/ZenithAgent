import { describe, expect, it, vi } from 'vitest';
import { CatalogSourceError, fetchImmCatalog, parseTileFormat, splitName } from '../src/index.js';

describe('parseTileFormat', () => {
  it('lee los formatos de la tienda', () => {
    expect(parseTileFormat('58.4x118.4/1.38m²/2 Piezas')).toEqual({
      pieceWidthCm: 58.4,
      pieceLengthCm: 118.4,
      areaPerBoxM2: 1.38,
      piecesPerBox: 2,
    });
    expect(parseTileFormat('60x60/1.80m²/5 Piezas')?.areaPerBoxM2).toBe(1.8);
  });

  it('tolera las variantes escritas a mano', () => {
    expect(parseTileFormat('29x118.4/1.37m/4 Piezas')?.areaPerBoxM2).toBe(1.37);
    expect(parseTileFormat(' 30 x 60 / 1,80 m2 / 10 piezas ')).toEqual({
      pieceWidthCm: 30,
      pieceLengthCm: 60,
      areaPerBoxM2: 1.8,
      piecesPerBox: 10,
    });
  });

  it('no adivina cuando no es un formato de cerámica', () => {
    expect(parseTileFormat('')).toBeNull();
    expect(parseTileFormat(null)).toBeNull();
    expect(parseTileFormat('Medidas 40x60')).toBeNull();
    expect(parseTileFormat('60x60/0m²/5 Piezas')).toBeNull();
  });
});

describe('splitName', () => {
  it('separa calidad y marca del nombre', () => {
    expect(splitName('Acasta / Primera Calidad')).toEqual({ name: 'Acasta', quality: 'Primera Calidad' });
    expect(splitName('Sanitario Loto Suspendido/ Marca Corona')).toEqual({ name: 'Sanitario Loto Suspendido', brand: 'Corona' });
    expect(splitName('Lavamanos Simple')).toEqual({ name: 'Lavamanos Simple' });
  });
});

describe('fetchImmCatalog', () => {
  const categories = [
    { slug: 'ceramicas', name: 'Cerámicas', icon: 'tiles', count: 1, in_visualizer: true },
    { slug: 'sanitarios', name: 'Sanitarios', icon: 'toilet', count: 1, in_visualizer: false },
  ];
  const products = {
    total: 3,
    items: [
      {
        id: 232,
        name: 'Brooklyn/ Primera Calidad',
        cat: 'ceramicas',
        fmt: '30x60/1.80m²/10 Piezas',
        desc: '',
        surface: 'Piso y pared',
        finish: 'Mate',
        usage: 'Interior y exterior',
        specs: 'Antideslizante/Texturizada',
        price: null,
        offer: false,
        old: null,
        imgs: ['data:image/webp;base64,AAAA'],
        // Así llegan las cerámicas reales: medidas de objeto en 0 = no aplica.
        obj_w_cm: 0,
        obj_h_cm: 0,
        obj_d_cm: 0,
      },
      {
        id: 300,
        name: 'Sanitario Cascade/ Marca Corona',
        cat: 'sanitarios',
        fmt: '',
        desc: 'One Piece de alta gama.',
        surface: '',
        finish: 'Brillante',
        usage: '',
        specs: '',
        price: 250,
        offer: false,
        obj_w_cm: 40,
        obj_h_cm: 68.1,
      },
      { id: 301, cat: 'sanitarios' },
    ],
  };

  const fakeFetch = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.endsWith('/categories') ? categories : url.endsWith('/products') ? products : null;
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
  });

  it('mapea productos, conserva lo útil para vender y rechaza los inválidos', async () => {
    const { products: out, rejected } = await fetchImmCatalog({ baseUrl: 'https://tienda.test', currency: 'USD', fetch: fakeFetch });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.index).toBe(2);

    expect(out[0]).toEqual({
      externalId: '232',
      name: 'Brooklyn',
      category: 'ceramicas',
      categoryName: 'Cerámicas',
      description: null,
      format: '30x60/1.80m²/10 Piezas',
      pieceWidthCm: 30,
      pieceLengthCm: 60,
      areaPerBoxM2: 1.8,
      piecesPerBox: 10,
      attributes: {
        surface: 'Piso y pared',
        finish: 'Mate',
        usage: 'Interior y exterior',
        features: ['Antideslizante', 'Texturizada'],
        quality: 'Primera Calidad',
      },
      price: null,
      currency: null,
      onOffer: false,
      inVisualizer: true,
    });

    expect(out[1]).toMatchObject({
      name: 'Sanitario Cascade',
      price: 250,
      currency: 'USD',
      areaPerBoxM2: null,
      inVisualizer: false,
      attributes: { brand: 'Corona', finish: 'Brillante', dimensions_cm: { width: 40, height: 68.1, depth: null } },
    });
    // Las imágenes embebidas no se copian.
    expect(JSON.stringify(out)).not.toContain('base64');
  });

  it('falla con un error claro si la tienda no responde bien', async () => {
    const down = vi.fn<typeof fetch>().mockResolvedValue(new Response('error', { status: 502 }));
    await expect(fetchImmCatalog({ baseUrl: 'https://tienda.test', currency: 'USD', fetch: down })).rejects.toThrow(CatalogSourceError);
  });

  it('exige https', async () => {
    await expect(fetchImmCatalog({ baseUrl: 'http://tienda.test', currency: 'USD', fetch: fakeFetch })).rejects.toThrow(
      CatalogSourceError,
    );
  });
});
