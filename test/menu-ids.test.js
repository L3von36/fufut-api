import { describe, it, expect } from 'vitest';
import {
  ensureMenuIds,
  stableItemId,
  categorizedToFlat,
  backfillMenuIdsFromD1,
} from '../src/handlers/menu.js';

/**
 * Stub D1 holding the rows the live mirror actually has: every item already
 * carries a randomly-minted id from an earlier syncMenuToD1 run.
 */
function fakeEnv(rows) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: rows }) }),
        all: async () => ({ results: rows }),
      }),
    },
  };
}

/**
 * The KV menu blob was stored without per-item ids, so categorizedToFlat emitted
 * `id: ""` for all 45 items. The POS cart matches lines by
 * `menuItemId === item.id`, so every product looked like the same product: adding
 * a 130 ETB macchiato to a cart holding a 65 ETB coffee merged into the coffee's
 * line and billed 2 x 65.
 */
const legacyBlob = () => ({
  restaurant: 'FU FUT COFFEE',
  categories: [
    {
      name: 'HOT DRINKS',
      items: [
        { name: 'Tridintional coffee', price: 65 },
        { name: 'Macchiato', price: 130 },
        { name: 'TEA', price: 70 },
      ],
    },
    {
      name: 'Breakfast',
      // The live menu really does carry two dishes with this same name at
      // different prices.
      items: [
        { name: 'Fut Special Gebeta', price: 1400 },
        { name: 'Fut Special Gebeta', price: 900 },
      ],
    },
  ],
});

describe('menu item ids', () => {
  it('fills in an id for every item that lacks one', () => {
    const { data, changed } = ensureMenuIds(legacyBlob());

    expect(changed).toBe(true);
    const ids = data.categories.flatMap((c) => c.items.map((i) => i.id));
    expect(ids).toHaveLength(5);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('gives every item a distinct id, including duplicate names', () => {
    const { data } = ensureMenuIds(legacyBlob());

    const ids = data.categories.flatMap((c) => c.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flattens to non-empty ids so the cart can tell items apart', () => {
    const { data } = ensureMenuIds(legacyBlob());
    const flat = categorizedToFlat(data);

    expect(flat).toHaveLength(5);
    expect(flat.filter((i) => i.id === '')).toHaveLength(0);
    expect(new Set(flat.map((i) => i.id)).size).toBe(5);
  });

  it('is deterministic across calls', () => {
    // The same blob is read on every request. A random id would differ between
    // the read that renders the menu and the next one, so a cart line could
    // never match its menu item.
    const first = ensureMenuIds(legacyBlob()).data;
    const second = ensureMenuIds(legacyBlob()).data;

    expect(categorizedToFlat(first).map((i) => i.id))
      .toEqual(categorizedToFlat(second).map((i) => i.id));
  });

  it('leaves existing ids untouched so identity survives a rename', () => {
    const blob = legacyBlob();
    blob.categories[0].items[0].id = 'MI-legacy-001';

    const { data, changed } = ensureMenuIds(blob);

    expect(data.categories[0].items[0].id).toBe('MI-legacy-001');
    // The remaining four still needed filling in.
    expect(changed).toBe(true);
  });

  it('reports no change when every item already has an id', () => {
    const { data } = ensureMenuIds(legacyBlob());
    const { changed } = ensureMenuIds(data);

    expect(changed).toBe(false);
  });

  it('derives different ids for different items and the same id for the same input', () => {
    expect(stableItemId('HOT DRINKS', 'Macchiato', 0))
      .toBe(stableItemId('HOT DRINKS', 'Macchiato', 0));
    expect(stableItemId('HOT DRINKS', 'Macchiato', 0))
      .not.toBe(stableItemId('HOT DRINKS', 'TEA', 0));
    // Same name, different category, must not collide.
    expect(stableItemId('HOT DRINKS', 'TEA', 0))
      .not.toBe(stableItemId('Drinks', 'TEA', 0));
  });

  it('tolerates a flat or empty payload without throwing', () => {
    expect(ensureMenuIds(null).changed).toBe(false);
    expect(ensureMenuIds([]).changed).toBe(false);
    expect(ensureMenuIds({ categories: [] }).changed).toBe(false);
  });
});

describe('backfilling ids onto pre-existing menu data', () => {
  // D1 already holds an id for every item; KV holds none. Adopting D1's ids
  // keeps the two stores agreeing, so the next /api/menus/save is a no-op
  // instead of deleting and re-inserting all 45 rows.
  const d1Rows = [
    { id: 'MIa93f095a', name: 'Tridintional coffee', category: 'HOT DRINKS' },
    { id: 'MI63e54c19', name: 'Macchiato', category: 'HOT DRINKS' },
    { id: 'MIdb5b4394', name: 'TEA', category: 'HOT DRINKS' },
    { id: 'MIaaa11111', name: 'Fut Special Gebeta', category: 'Breakfast' },
    { id: 'MIbbb22222', name: 'Fut Special Gebeta', category: 'Breakfast' },
  ];

  it('adopts the id D1 already holds for each item', async () => {
    const blob = legacyBlob();
    const report = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);

    expect(report.total).toBe(5);
    expect(report.adopted).toBe(5);
    expect(report.minted).toBe(0);

    const flat = categorizedToFlat(blob);
    expect(flat.find((i) => i.name === 'Tridintional coffee').id).toBe('MIa93f095a');
    expect(flat.find((i) => i.name === 'Macchiato').id).toBe('MI63e54c19');
  });

  it('gives duplicate-named dishes two different existing ids', async () => {
    const blob = legacyBlob();
    await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);

    const gebeta = blob.categories[1].items.map((i) => i.id);
    expect(new Set(gebeta).size).toBe(2);
    expect(gebeta).toEqual(expect.arrayContaining(['MIaaa11111', 'MIbbb22222']));
  });

  it('mints an id for an item D1 has never seen', async () => {
    const blob = legacyBlob();
    blob.categories[0].items.push({ name: 'Brand New Latte', price: 140 });

    const report = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);

    expect(report.adopted).toBe(5);
    expect(report.minted).toBe(1);
    const added = blob.categories[0].items.find((i) => i.name === 'Brand New Latte');
    expect(added.id).toBeTruthy();
  });

  it('never assigns the same id to two items', async () => {
    const blob = legacyBlob();
    blob.categories[0].items.push({ name: 'Brand New Latte', price: 140 });

    await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);

    const ids = blob.categories.flatMap((c) => c.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is idempotent — a second run adopts nothing and writes nothing', async () => {
    const blob = legacyBlob();
    await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);
    const second = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);

    expect(second.alreadyHadId).toBe(5);
    expect(second.adopted).toBe(0);
    expect(second.minted).toBe(0);
  });

  it('still assigns ids when D1 is unreachable', async () => {
    const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
    const blob = legacyBlob();

    const report = await backfillMenuIdsFromD1(broken, blob);

    expect(report.minted).toBe(5);
    expect(categorizedToFlat(blob).filter((i) => i.id === '')).toHaveLength(0);
  });

  describe('force mode', () => {
    // The race this exists for: /api/menu is public, so the lazy KV self-heal
    // usually writes deterministic ids before an operator can run the repair.
    // Those ids are valid but differ from D1's, leaving the stores disagreeing.
    const selfHealed = () => {
      const blob = legacyBlob();
      ensureMenuIds(blob);
      return blob;
    };

    it('leaves the divergence in place without force', async () => {
      const blob = selfHealed();
      const report = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);

      expect(report.alreadyHadId).toBe(5);
      expect(report.realigned).toBe(0);
      // Still disagreeing with D1.
      const coffee = blob.categories[0].items[0];
      expect(coffee.id).not.toBe('MIa93f095a');
    });

    it('re-aligns self-healed ids onto the ids D1 holds', async () => {
      const blob = selfHealed();
      const report = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob, { force: true });

      expect(report.realigned).toBe(5);
      expect(report.alreadyHadId).toBe(0);

      const flat = categorizedToFlat(blob);
      expect(flat.find((i) => i.name === 'Tridintional coffee').id).toBe('MIa93f095a');
      expect(flat.find((i) => i.name === 'Macchiato').id).toBe('MI63e54c19');
      expect(flat.find((i) => i.name === 'TEA').id).toBe('MIdb5b4394');
    });

    it('reports no change when force runs against an already-aligned blob', async () => {
      const blob = legacyBlob();
      await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob);
      const second = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob, { force: true });

      expect(second.unchanged).toBe(5);
      expect(second.realigned).toBe(0);
      expect(second.minted).toBe(0);
    });

    it('keeps the id of an item D1 has no row for instead of churning it', async () => {
      const blob = selfHealed();
      blob.categories[0].items.push({ id: 'MI-manual-latte', name: 'Brand New Latte', price: 140 });

      const report = await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob, { force: true });

      expect(report.kept).toBe(1);
      const added = blob.categories[0].items.find((i) => i.name === 'Brand New Latte');
      expect(added.id).toBe('MI-manual-latte');
    });

    it('never produces a duplicate id while re-aligning', async () => {
      const blob = selfHealed();
      blob.categories[0].items.push({ id: 'MI-manual-latte', name: 'Brand New Latte', price: 140 });

      await backfillMenuIdsFromD1(fakeEnv(d1Rows), blob, { force: true });

      const ids = blob.categories.flatMap((c) => c.items.map((i) => i.id));
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('does not strip ids when D1 is unreachable under force', async () => {
      // Worst case: force clears ids, then the D1 read fails. Every item must
      // still come out with an id rather than being wiped.
      const broken = { DB: { prepare: () => { throw new Error('D1 down'); } } };
      const blob = selfHealed();
      const before = blob.categories.flatMap((c) => c.items.map((i) => i.id));

      const report = await backfillMenuIdsFromD1(broken, blob, { force: true });

      const after = blob.categories.flatMap((c) => c.items.map((i) => i.id));
      expect(after.every(Boolean)).toBe(true);
      expect(after).toEqual(before);
      expect(report.kept).toBe(5);
    });
  });
});
