import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import sharp from 'sharp';
import { withTenant, type Pool } from '@zenith/db';
import { normalizeImage, syncProducts, type ProductInput } from '@zenith/catalog';
import { describeCatalog, parseLook } from '../src/catalog-look.js';
import { categoryPattern, createCatalogReader, termPattern } from '../src/catalog-reader.js';
import { hasDb, seedTenant, setupDb } from '../../../packages/db/test/helpers.js';
import { scriptedLlm, text } from '../../../packages/brain/test/fake-llm.js';

describe('parseLook', () => {
  it('lee el JSON aunque venga envuelto en ```json y normaliza a minúsculas', () => {
    const look = parseLook('```json\n{"aspecto":["Madera","geométrico"],"colores":["Gris","gris","blanco"],"patron":"Chevron","descripcion":"Piso gris tipo madera en diagonal."}\n```');
    expect(look).toEqual({ aspecto: ['madera', 'geométrico'], colores: ['gris', 'blanco'], patron: 'chevron', descripcion: 'Piso gris tipo madera en diagonal.' });
  });
  it('devuelve null si el modelo no manda un JSON válido', () => {
    expect(parseLook('No puedo ver la imagen')).toBeNull();
    expect(parseLook('{"aspecto":"madera"}')).toBeNull();
  });
});

describe.skipIf(!hasDb)('descripción visual del catálogo', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;

  const tile = (externalId: string, name: string, images: ProductInput['images']): ProductInput => ({
    externalId,
    name,
    category: 'ceramicas',
    categoryName: 'Cerámicas',
    description: null,
    format: '60x60/1.80m²/5 Piezas',
    pieceWidthCm: 60,
    pieceLengthCm: 60,
    areaPerBoxM2: 1.8,
    piecesPerBox: 5,
    // Como en la tienda: sin color ni diseño.
    attributes: { finish: 'Mate', surface: 'Piso y pared' },
    price: null,
    currency: null,
    onOffer: false,
    inVisualizer: true,
    images,
  });

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'look');
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888888' } }).jpeg().toBuffer();
    const photo = await normalizeImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    await withTenant(app, t.tenantId, (c) =>
      syncProducts(c, t.tenantId, 'imm_store', [tile('1', 'Archi Cenizo', [photo!]), tile('2', 'Sin Foto', [])]),
    );
  });

  afterAll(async () => {
    if (t) await owner.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
    await owner?.end();
    await app?.end();
  });

  it('describe solo los productos con foto, lo guarda aparte y la búsqueda lo encuentra por su aspecto', async () => {
    const reader = createCatalogReader(app, t.tenantId);
    const search = (q: string) => reader.search({ text: q, category: null, surface: null, usage: null, limit: 5 });
    // Sin la descripción de la foto, nada en la ficha dice madera ni chevron.
    expect(await search('madera chevron')).toEqual([]);

    const { llm, calls } = scriptedLlm([
      text('{"aspecto":["madera","geométrico"],"colores":["gris"],"patron":"chevron","descripcion":"Listones grises tipo madera en diagonal."}'),
    ]);
    const result = await describeCatalog({ pool: app, tenantId: t.tenantId, llm, model: 'modelo-prueba' });
    expect(result).toEqual({ described: 1, skipped: 0, failed: [] });
    // El modelo recibió la foto del producto.
    expect(JSON.stringify(calls[0]?.messages)).toContain('"type":"image"');

    const found = await search('gris madera');
    expect(found.map((p) => p.name)).toEqual(['Archi Cenizo']);
    expect(found[0]?.look?.patron).toBe('chevron');

    // Una nueva sincronización no borra la descripción, y no se vuelve a describir sin cambios.
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888888' } }).jpeg().toBuffer();
    const photo = await normalizeImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    await withTenant(app, t.tenantId, (c) => syncProducts(c, t.tenantId, 'imm_store', [tile('1', 'Archi Cenizo', [photo!])]));
    expect((await search('chevron')).map((p) => p.name)).toEqual(['Archi Cenizo']);
    const again = await describeCatalog({ pool: app, tenantId: t.tenantId, llm: scriptedLlm([]).llm, model: 'modelo-prueba' });
    expect(again.described).toBe(0);
  });

  it('entrega la primera foto de cada producto achicada a JPEG para el modelo', async () => {
    const reader = createCatalogReader(app, t.tenantId);
    const [archi] = await reader.search({ text: 'archi', category: null, surface: null, usage: null, limit: 1 });
    // Un id sin foto (o de otro negocio) simplemente no aparece.
    const photos = await reader.photos!([archi!.id, '00000000-0000-4000-8000-000000000000']);
    expect([...photos.keys()]).toEqual([archi!.id]);
    const jpeg = Buffer.from(photos.get(archi!.id)!.base64, 'base64');
    expect(photos.get(archi!.id)!.mediaType).toBe('image/jpeg');
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(await reader.photos!([])).toEqual(new Map());
  });
});

describe('termPattern', () => {
  it('une el masculino y el femenino y agrega los nombres de color de los modelos', () => {
    expect(termPattern('negra')).toBe('\\m(?:negr|nero|black)');
    expect(termPattern('negro')).toBe('\\m(?:negr|nero|black)');
    expect(termPattern('blanca')).toBe('\\m(?:blanc|bianc|white|nieve)');
    expect(termPattern('gris')).toBe('\\m(?:gris|grigi|grey|gray|plomo|ceniz|grafit|perla)');
    expect(termPattern('beige')).toBe('\\m(?:beige|crema|arena|marfil|hueso|sand)');
    expect(termPattern('azul')).toBe('\\m(?:azul|turquesa|celeste|aqua|blue)');
    expect(termPattern('marmoleado')).toBe('\\m(?:marmolead|marmol|marble|carrara)');
    expect(termPattern('grisaceo')).toBe('\\m(?:grisace|gris|grigi|grey|gray|plomo|ceniz|grafit|perla)');
    expect(termPattern('piso')).toBe('\\m(?:piso)');
  });
});

describe('categoryPattern', () => {
  it('"cerámica" o "porcelanato" buscan en todos los revestimientos', () => {
    for (const t of ['ceramica', 'porcelanato', 'ceranatto', 'revestimiento', 'piso']) expect(categoryPattern(t)).toBe('ceramic|ceranatt|porcelanat');
    // Sanitarios y lavamanos, con como se les dice en Venezuela y otros países.
    for (const t of ['sanitarios', 'poceta', 'inodoro']) expect(categoryPattern(t)).toBe('sanitari');
    for (const t of ['lavamano', 'lavabo', 'ovalin']) expect(categoryPattern(t)).toBe('lavaman');
    expect(categoryPattern(null)).toBeNull();
  });
});

describe.skipIf(!hasDb)('orden de la búsqueda por relevancia', () => {
  let owner: pg.Pool;
  let app: Pool;
  let t: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    t = await seedTenant(owner, 'orden');
    const add = (id: string, name: string, colores: string[], attributes: Record<string, unknown>) =>
      owner.query(
        `INSERT INTO products (tenant_id, source, external_id, name, category, category_name, attributes, look)
         VALUES ($1, 'prueba', $2, $3, 'ceramicas', 'Cerámicas', $4, $5)`,
        [t.tenantId, id, name, attributes, { aspecto: ['piedra'], colores, patron: null, descripcion: 'Cerámica.' }],
      );
    // Adrisa: la ficha dice "Negro" pero la foto es gris (pasa en el catálogo real).
    await add('1', 'Adrisa Dual', ['gris', 'grisáceo'], { color: 'Negro' });
    await add('2', 'Brooklyn', ['gris oscuro', 'óxido', 'negro'], {});
    await add('3', 'Notte Nero', ['negro', 'gris'], { color: 'Negro' });
    await add('4', 'Blanco Sal', ['blanco'], {});
    // Madera clara en otra categoría (como los Ceranattos del catálogo real) y un gris claro que no es madera.
    await owner.query(
      `INSERT INTO products (tenant_id, source, external_id, name, category, category_name, attributes, look)
       VALUES ($1, 'prueba', '5', 'Cedrus Dual', 'ceranattos', 'Ceranattos', '{}', $2),
              ($1, 'prueba', '6', 'Itria Clara', 'ceramicas', 'Cerámicas', '{}', $3)`,
      [
        t.tenantId,
        { aspecto: ['madera', 'natural'], colores: ['beige', 'marrón claro'], patron: 'listones', descripcion: 'Imita la madera natural.' },
        { aspecto: ['cemento'], colores: ['gris claro'], patron: null, descripcion: 'Acabado tipo cemento.' },
      ],
    );
  });

  afterAll(async () => {
    if (t) await owner.query('DELETE FROM tenants WHERE id = $1', [t.tenantId]);
    await owner?.end();
    await app?.end();
  });

  it('pone primero lo que de verdad es del color pedido, no el orden alfabético', async () => {
    const reader = createCatalogReader(app, t.tenantId);
    const search = (q: string, limit = 5) => reader.search({ text: q, category: null, surface: null, usage: null, limit });
    // "cerámica" coincide con todas: las que además son negras van primero.
    expect((await search('cerámica negra')).map((p) => p.name).slice(0, 3)).toEqual(['Notte Nero', 'Brooklyn', 'Adrisa Dual']);
    expect((await search('negro', 2)).map((p) => p.name)).toEqual(['Notte Nero', 'Brooklyn']);
    expect((await search('blancas')).map((p) => p.name)).toEqual(['Blanco Sal']);
    // Cumplir las dos palabras ("madera" y "clara") pesa más que coincidir fuerte en una sola.
    expect((await search('madera clara'))[0]?.name).toBe('Cedrus Dual');
    // "cerámica" como categoría incluye los Ceranattos.
    const tiles = await reader.search({ text: 'madera', category: 'cerámica', surface: null, usage: null, limit: 5 });
    expect(tiles.map((p) => p.name)).toContain('Cedrus Dual');
  });
});
