import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withTenant, type Pool } from '@zenith/db';
import { syncProducts, type ProductInput } from '../src/index.js';
import { hasDb, seedTenant, setupDb } from '../../db/test/helpers.js';

const product = (externalId: string, name: string): ProductInput => ({
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
  attributes: { finish: 'Mate' },
  price: null,
  currency: null,
  onOffer: false,
  inVisualizer: true,
});

describe.skipIf(!hasDb)('syncProducts', () => {
  let owner: pg.Pool;
  let app: Pool;
  let a: Awaited<ReturnType<typeof seedTenant>>;
  let b: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    ({ owner, app } = await setupDb());
    a = await seedTenant(owner, 'cat-a');
    b = await seedTenant(owner, 'cat-b');
  });

  afterAll(async () => {
    await owner?.query('DELETE FROM tenants WHERE id = ANY($1)', [[a?.tenantId, b?.tenantId].filter(Boolean)]);
    await owner?.end();
    await app?.end();
  });

  const list = (tenantId: string) =>
    withTenant(app, tenantId, async (c) =>
      (await c.query('SELECT external_id, name, active, area_per_box_m2 FROM products ORDER BY external_id')).rows,
    );

  it('inserta, actualiza y desactiva lo que ya no está en la fuente', async () => {
    await withTenant(app, a.tenantId, (c) => syncProducts(c, a.tenantId, 'imm_store', [product('1', 'Brooklyn'), product('2', 'Sinai')]));
    const second = await withTenant(app, a.tenantId, (c) =>
      syncProducts(c, a.tenantId, 'imm_store', [product('1', 'Brooklyn Mate')]),
    );
    expect(second).toEqual({ upserted: 1, deactivated: 1 });
    expect(await list(a.tenantId)).toEqual([
      { external_id: '1', name: 'Brooklyn Mate', active: true, area_per_box_m2: '1.800' },
      { external_id: '2', name: 'Sinai', active: false, area_per_box_m2: '1.800' },
    ]);
  });

  it('una fuente vacía no vacía el catálogo', async () => {
    expect(await withTenant(app, a.tenantId, (c) => syncProducts(c, a.tenantId, 'imm_store', []))).toEqual({ upserted: 0, deactivated: 0 });
    expect((await list(a.tenantId)).find((p) => p.external_id === '1')?.active).toBe(true);
  });

  it('el catálogo de un tenant no toca el de otro', async () => {
    await withTenant(app, b.tenantId, (c) => syncProducts(c, b.tenantId, 'imm_store', [product('1', 'Otro')]));
    expect((await list(a.tenantId)).find((p) => p.external_id === '1')?.name).toBe('Brooklyn Mate');
    expect(await list(b.tenantId)).toEqual([{ external_id: '1', name: 'Otro', active: true, area_per_box_m2: '1.800' }]);
  });

  it('rechaza productos repetidos en la fuente', async () => {
    await expect(
      withTenant(app, a.tenantId, (c) => syncProducts(c, a.tenantId, 'imm_store', [product('9', 'x'), product('9', 'y')])),
    ).rejects.toThrow('repetido');
  });
});
