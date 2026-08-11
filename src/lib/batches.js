/**
 * Batch allocation — FEFO.
 *
 * ── The bug this fixes ──────────────────────────────────────────────────────
 *
 * `inventory_batches.qty_remaining` was written when a purchase was received
 * and **never decremented**. Nothing consumed it, so `/api/inventory/expiring`
 * reported the full delivered quantity forever: milk drunk three weeks ago
 * still showed as stock at risk. An expiry report that is confidently wrong is
 * worse than no expiry report, because somebody acts on it.
 *
 * ── FEFO, not FIFO ──────────────────────────────────────────────────────────
 *
 * First *expired*, first out. For perishables that is the rule that matters:
 * the carton bought later may well be the one that goes off first, and using
 * the oldest-received one would leave it on the shelf to spoil. Received date
 * is only the tie-break for batches sharing an expiry, and for batches with no
 * expiry at all — where FEFO degenerates to FIFO, which is correct.
 *
 * ── Why allocations are recorded ────────────────────────────────────────────
 *
 * A reversal has to put stock back where it came from. Without the allocation
 * we would have to guess a batch, and guessing wrong moves a quantity onto a
 * carton with a different expiry date — quietly corrupting the very report this
 * exists to make honest. The allocation is stored on the movement row that
 * consumed it (`stock_movements.batch_alloc`), so reversing is exact.
 */

import { d1Query, d1Run } from './db.js';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Order batches for consumption.
 *
 * Batches with no expiry sort last: a dated carton should always be used before
 * an undated sack of the same thing, because only one of them can spoil.
 */
export function sortForConsumption(batches) {
  return [...(batches || [])].sort((a, b) => {
    const ax = a.expiry_date || null;
    const bx = b.expiry_date || null;
    if (ax && bx && ax !== bx) return ax < bx ? -1 : 1;
    if (ax && !bx) return -1;
    if (!ax && bx) return 1;
    // Same expiry, or neither has one — fall back to oldest received.
    const ar = a.received_at || '';
    const br = b.received_at || '';
    if (ar !== br) return ar < br ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Split `qty` across open batches, first-to-expire first.
 *
 * @returns {{allocations: Array<{batchId, qty, expiryDate}>, shortfall: number}}
 *
 * `shortfall` is what could not be covered by any batch. It is returned rather
 * than thrown: stock going further than the batches account for is a real
 * situation — deliveries recorded late, opening stock that predates batch
 * tracking — and it must not block a sale that has already happened. The
 * movement still records the full quantity; only the batch drawdown is partial.
 */
export function allocateFEFO(batches, qty) {
  let needed = Math.abs(num(qty));
  const allocations = [];
  if (needed <= 0) return { allocations, shortfall: 0 };

  for (const batch of sortForConsumption(batches)) {
    if (needed <= 1e-9) break;
    const available = num(batch.qty_remaining);
    if (available <= 0) continue;
    const take = Math.min(available, needed);
    allocations.push({
      batchId: batch.id,
      qty: Math.round(take * 10000) / 10000,
      expiryDate: batch.expiry_date || null,
    });
    needed -= take;
  }

  return {
    allocations,
    shortfall: needed > 1e-9 ? Math.round(needed * 10000) / 10000 : 0,
  };
}

/**
 * Apply an allocation back onto the batch rows.
 *
 * `direction` is -1 to consume and +1 to restore. A batch that reaches zero is
 * marked depleted rather than deleted, so the history of what was received and
 * when it ran out survives — the same rule the rest of the system follows.
 */
export async function applyAllocation(env, allocations, direction = -1) {
  for (const alloc of allocations || []) {
    const { results } = await d1Query(env, 'SELECT * FROM inventory_batches WHERE id = ?', [
      alloc.batchId,
    ]);
    const batch = results && results[0];
    if (!batch) continue;

    const next = Math.max(0, num(batch.qty_remaining) + direction * num(alloc.qty));
    const rounded = Math.round(next * 10000) / 10000;
    // Restoring to a depleted batch reopens it; that batch's expiry date is
    // still the right one for the quantity going back.
    const status = rounded <= 0 ? 'depleted' : 'open';

    await d1Run(env, 'UPDATE inventory_batches SET qty_remaining = ?, status = ? WHERE id = ?', [
      rounded,
      status,
      alloc.batchId,
    ]);
  }
}

/** Open batches for an item, or an empty list if the table is not there yet. */
export async function openBatchesFor(env, inventoryId) {
  try {
    const { results } = await d1Query(
      env,
      "SELECT * FROM inventory_batches WHERE inventory_id = ? AND status = 'open' AND qty_remaining > 0",
      [String(inventoryId)]
    );
    return results || [];
  } catch {
    // Before migration 006 the table does not exist. Batch tracking is an
    // enhancement to the ledger, never a precondition for it.
    return [];
  }
}

/**
 * Draw stock out of batches for a consuming movement.
 *
 * Returns the allocation to store on the movement row, or null when the item is
 * not batch-tracked — most things are not, and only perishables get batches.
 */
export async function consumeFromBatches(env, inventoryId, qty) {
  const batches = await openBatchesFor(env, inventoryId);
  if (!batches.length) return null;

  const { allocations, shortfall } = allocateFEFO(batches, qty);
  if (!allocations.length) return null;

  await applyAllocation(env, allocations, -1);
  return { allocations, shortfall };
}

/**
 * Put stock back into the exact batches a previous movement took it from.
 *
 * Reads the stored allocation rather than re-deriving one: re-deriving would
 * pick today's first-to-expire batch, which is generally not the batch the
 * stock came out of, and would move quantity onto a carton with the wrong date.
 */
export async function restoreToBatches(env, refType, refId) {
  try {
    const { results } = await d1Query(
      env,
      'SELECT batch_alloc FROM stock_movements WHERE ref_type = ? AND ref_id = ? AND batch_alloc IS NOT NULL',
      [refType, refId]
    );
    let restored = 0;
    for (const row of results || []) {
      let parsed;
      try { parsed = JSON.parse(row.batch_alloc); } catch { continue; }
      const allocations = parsed && parsed.allocations ? parsed.allocations : parsed;
      if (!Array.isArray(allocations)) continue;
      await applyAllocation(env, allocations, +1);
      restored += allocations.length;
    }
    return restored;
  } catch {
    return 0;
  }
}
