/**
 * Units and conversion.
 *
 * The spec is explicit that inventory must not be "generic items": coffee is
 * bought in kg and used in grams, milk is bought in litres and used in
 * millilitres, and cups are counted. A recipe that says "18" is meaningless
 * without knowing 18 of what.
 *
 * ── The design ──────────────────────────────────────────────────────────────
 *
 * Every unit belongs to a **dimension** (mass, volume, count) and converts to
 * that dimension's **base unit** by a fixed factor. Stock is held in the item's
 * own unit; a recipe line may be written in any unit of the same dimension and
 * is converted at the point of use.
 *
 * Conversion across dimensions is refused, never guessed. "200 g of milk" is a
 * real thing a person might type, and turning it into millilitres requires a
 * density this system does not have — quietly assuming 1 g = 1 ml would put a
 * plausible wrong number into a stock ledger, which is worse than an error
 * message.
 *
 * ── Why count units do not convert to each other ────────────────────────────
 *
 * A box, a packet and a bag are not fixed quantities. A box of cups might hold
 * 50 or 1,000. Physics fixes 1 kg = 1000 g for all time; nothing fixes a box.
 * So count units convert only to themselves, and buying by the box is expressed
 * with the item's `pack_size` (see packToBase), which is per-item data rather
 * than a universal constant.
 */

/** unit → { dimension, toBase } where toBase converts INTO the base unit. */
const UNITS = {
  // ── mass, base gram ──
  mg: { dimension: 'mass', toBase: 0.001, label: 'mg' },
  g: { dimension: 'mass', toBase: 1, label: 'g' },
  gram: { dimension: 'mass', toBase: 1, label: 'g' },
  grams: { dimension: 'mass', toBase: 1, label: 'g' },
  kg: { dimension: 'mass', toBase: 1000, label: 'kg' },
  kilo: { dimension: 'mass', toBase: 1000, label: 'kg' },
  kilogram: { dimension: 'mass', toBase: 1000, label: 'kg' },

  // ── volume, base millilitre ──
  ml: { dimension: 'volume', toBase: 1, label: 'ml' },
  millilitre: { dimension: 'volume', toBase: 1, label: 'ml' },
  cl: { dimension: 'volume', toBase: 10, label: 'cl' },
  l: { dimension: 'volume', toBase: 1000, label: 'l' },
  litre: { dimension: 'volume', toBase: 1000, label: 'l' },
  liter: { dimension: 'volume', toBase: 1000, label: 'l' },
  litres: { dimension: 'volume', toBase: 1000, label: 'l' },

  // ── count, each its own base ──
  // Deliberately not inter-convertible; see the module comment.
  piece: { dimension: 'count', toBase: 1, label: 'piece', countKind: 'piece' },
  pcs: { dimension: 'count', toBase: 1, label: 'piece', countKind: 'piece' },
  pc: { dimension: 'count', toBase: 1, label: 'piece', countKind: 'piece' },
  each: { dimension: 'count', toBase: 1, label: 'piece', countKind: 'piece' },
  unit: { dimension: 'count', toBase: 1, label: 'piece', countKind: 'piece' },
  packet: { dimension: 'count', toBase: 1, label: 'packet', countKind: 'packet' },
  pack: { dimension: 'count', toBase: 1, label: 'packet', countKind: 'packet' },
  // The POS inventory form has offered "packs" since it was written, so rows in
  // production already carry it. Omitting it would make every conversion on
  // those items throw at the point of sale.
  packs: { dimension: 'count', toBase: 1, label: 'packet', countKind: 'packet' },
  pieces: { dimension: 'count', toBase: 1, label: 'piece', countKind: 'piece' },
  bottles: { dimension: 'count', toBase: 1, label: 'bottle', countKind: 'bottle' },
  cups: { dimension: 'count', toBase: 1, label: 'cup', countKind: 'cup' },
  bags: { dimension: 'count', toBase: 1, label: 'bag', countKind: 'bag' },
  boxes: { dimension: 'count', toBase: 1, label: 'box', countKind: 'box' },
  box: { dimension: 'count', toBase: 1, label: 'box', countKind: 'box' },
  bottle: { dimension: 'count', toBase: 1, label: 'bottle', countKind: 'bottle' },
  cup: { dimension: 'count', toBase: 1, label: 'cup', countKind: 'cup' },
  bag: { dimension: 'count', toBase: 1, label: 'bag', countKind: 'bag' },
  can: { dimension: 'count', toBase: 1, label: 'can', countKind: 'can' },
  crate: { dimension: 'count', toBase: 1, label: 'crate', countKind: 'crate' },
};

/** Base unit per dimension. */
const BASE = { mass: 'g', volume: 'ml', count: 'piece' };

export function normaliseUnit(unit) {
  if (unit === null || unit === undefined) return null;
  const key = String(unit).trim().toLowerCase().replace(/\.$/, '');
  return UNITS[key] ? key : null;
}

export function unitInfo(unit) {
  const key = normaliseUnit(unit);
  return key ? { key, ...UNITS[key] } : null;
}

export function dimensionOf(unit) {
  const info = unitInfo(unit);
  return info ? info.dimension : null;
}

export function isKnownUnit(unit) {
  return normaliseUnit(unit) !== null;
}

/** Every unit the UI may offer, grouped for a dropdown. */
export function unitCatalogue() {
  const seen = new Set();
  const out = { mass: [], volume: [], count: [] };
  for (const [key, info] of Object.entries(UNITS)) {
    const id = info.dimension + ':' + info.label;
    if (seen.has(id)) continue;
    seen.add(id);
    out[info.dimension].push({ unit: key, label: info.label, dimension: info.dimension });
  }
  return out;
}

/**
 * Can a quantity in `from` be expressed in `to`?
 *
 * Same dimension is necessary but not sufficient for counts: piece → box is
 * within `count` and is still not convertible without a pack size.
 */
export function areCompatible(from, to) {
  const a = unitInfo(from);
  const b = unitInfo(to);
  if (!a || !b) return false;
  if (a.dimension !== b.dimension) return false;
  if (a.dimension === 'count') return a.countKind === b.countKind;
  return true;
}

/**
 * Convert a quantity between units.
 *
 * Throws rather than returning a fallback. A conversion failure inside a stock
 * calculation must stop that calculation: the alternative is a number that
 * looks like an answer, and the whole point of the ledger is that its figures
 * can be trusted.
 *
 * @throws {Error} on an unknown or incompatible unit
 */
export function convert(qty, from, to) {
  const a = unitInfo(from);
  const b = unitInfo(to);
  if (!a) throw new Error(`Unknown unit "${from}"`);
  if (!b) throw new Error(`Unknown unit "${to}"`);
  if (a.dimension !== b.dimension) {
    throw new Error(
      `Cannot convert ${a.label} (${a.dimension}) to ${b.label} (${b.dimension}) — these measure different things`
    );
  }
  if (a.dimension === 'count' && a.countKind !== b.countKind) {
    throw new Error(
      `Cannot convert ${a.label} to ${b.label} without knowing how many ${b.label === 'piece' ? 'pieces' : b.label + 's'} are in one — set a pack size on the item`
    );
  }
  const n = Number(qty);
  if (!Number.isFinite(n)) throw new Error(`Quantity "${qty}" is not a number`);
  return (n * a.toBase) / b.toBase;
}

/** Convert into the dimension's base unit (g, ml, or the count unit itself). */
export function toBase(qty, unit) {
  const info = unitInfo(unit);
  if (!info) throw new Error(`Unknown unit "${unit}"`);
  if (info.dimension === 'count') return { qty: Number(qty) || 0, unit: info.label };
  return { qty: convert(qty, unit, BASE[info.dimension]), unit: BASE[info.dimension] };
}

/**
 * Convert a pack quantity (boxes, packets) into the item's stocking unit using
 * the item's own pack size — the per-item data that makes "3 boxes" meaningful.
 *
 * @param {number} qty       how many packs
 * @param {number} packSize  how much is in one pack, expressed in `stockUnit`
 */
export function packToBase(qty, packSize, stockUnit) {
  const size = Number(packSize);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('A pack size greater than zero is required to convert packs');
  }
  return { qty: (Number(qty) || 0) * size, unit: normaliseUnit(stockUnit) || stockUnit };
}

/**
 * Round to a sensible number of places for the dimension.
 *
 * Grams and millilitres are counted whole in practice; kilograms and litres
 * need three places, because 18 g of coffee is 0.018 kg and rounding that to
 * two would make every espresso consume nothing.
 */
export function roundQty(qty, unit) {
  const info = unitInfo(unit);
  const n = Number(qty) || 0;
  if (!info) return Math.round(n * 1000) / 1000;
  if (info.dimension === 'count') return Math.round(n * 100) / 100;
  // A unit whose base factor is large (kg, litre) is displayed with more places.
  const places = info.toBase >= 1000 ? 4 : 2;
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

/** Human-readable, e.g. formatQty(0.018, 'kg') → "0.018 kg". */
export function formatQty(qty, unit) {
  const info = unitInfo(unit);
  return `${roundQty(qty, unit)} ${info ? info.label : unit || ''}`.trim();
}

export { UNITS, BASE };
