/**
 * Order and item lifecycle timing.
 *
 * The question being answered is "how long did this take to reach the table",
 * per line rather than per order, because a cappuccino and a firfir leave the
 * pass at very different times and an order-level average hides exactly the
 * difference the kitchen needs to see.
 *
 * Pure functions only; the handler supplies the rows.
 */

/** The order a line moves through. Index position defines "further along". */
export const ITEM_FLOW = ['new', 'preparing', 'ready', 'served'];

/** Which column records the moment a line entered a given state. */
const STAMP_COLUMN = {
  preparing: 'preparing_at',
  ready: 'ready_at',
  served: 'served_at',
};

export function stampColumnFor(status) {
  return STAMP_COLUMN[String(status || '').toLowerCase()] || null;
}

export function isValidItemStatus(status) {
  return ITEM_FLOW.includes(String(status || '').toLowerCase());
}

export function flowIndex(status) {
  return ITEM_FLOW.indexOf(String(status || '').toLowerCase());
}

/**
 * Roll item states up into the order's state.
 *
 * The kitchen board is per order, so an order has to have one status even when
 * its lines disagree. The rule is deliberately pessimistic: an order only
 * counts as ready when nothing is still being made, and only as served when
 * every line has landed. Reporting an order ready while a dish is still on the
 * pass is how food goes out cold.
 */
export function deriveOrderStatus(itemStatuses) {
  const states = (itemStatuses || [])
    .map((s) => String(s || '').toLowerCase())
    .filter(isValidItemStatus);

  if (!states.length) return null;
  if (states.every((s) => s === 'served')) return 'served';
  if (states.every((s) => s === 'ready' || s === 'served')) return 'ready';
  if (states.some((s) => s !== 'new')) return 'preparing';
  return 'new';
}

/** Whole minutes between two timestamps, or null if either is missing. */
export function minutesBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const mins = (b - a) / 60000;
  if (mins < 0) return null;
  return Math.round(mins * 10) / 10;
}

/**
 * The three intervals worth reporting for one line:
 *   waited   - sat in the queue before anyone started it
 *   cooked   - actually being made
 *   toTable  - ordered until it reached the guest, which is the number the
 *              guest experiences and the one being asked for here
 */
export function itemDurations(item) {
  if (!item) return { waited: null, cooked: null, toTable: null };
  const created = item.created_at;
  return {
    waited: minutesBetween(created, item.preparing_at),
    cooked: minutesBetween(item.preparing_at, item.ready_at),
    toTable: minutesBetween(created, item.served_at),
  };
}

/**
 * Average time-to-table per category.
 *
 * Only lines that actually reached the table are counted: an unserved line has
 * no duration, and treating it as zero would drag every average down and make
 * a slow service look fast. Categories with no completed lines are omitted
 * rather than reported as zero, for the same reason.
 */
export function averageByCategory(items) {
  const buckets = new Map();

  for (const item of items || []) {
    const mins = minutesBetween(item.created_at, item.served_at);
    if (mins === null) continue;
    const key = item.category || 'Uncategorised';
    const b = buckets.get(key) || { category: key, count: 0, total: 0, slowest: 0, fastest: Infinity };
    b.count += 1;
    b.total += mins;
    b.slowest = Math.max(b.slowest, mins);
    b.fastest = Math.min(b.fastest, mins);
    buckets.set(key, b);
  }

  return Array.from(buckets.values())
    .map((b) => ({
      category: b.category,
      served: b.count,
      averageMinutes: Math.round((b.total / b.count) * 10) / 10,
      fastestMinutes: b.fastest,
      slowestMinutes: b.slowest,
    }))
    .sort((a, b) => b.averageMinutes - a.averageMinutes);
}

/**
 * Read the flat order summary the POS writes to orders.items.
 *
 * Shapes seen in production: "1xMacchiato, 1xFut breakfast Gebeta" and
 * "2x Latte [oat-milk, vanilla] (extra hot), 1x Espresso". Splitting on a comma
 * alone would break every dish whose name contains one, so the split is made
 * only where a comma is followed by the next "<qty>x" marker.
 */
export function parseFlatItems(flat) {
  const text = String(flat == null ? '' : flat).trim();
  if (!text) return [];

  return text
    .split(/,\s*(?=\d+\s*x)/i)
    .map((chunk) => {
      const m = chunk.trim().match(/^(\d+)\s*x\s*(.+)$/i);
      if (!m) return null;
      const name = m[2]
        .replace(/\[[^\]]*\]/g, '')  // modifier list
        .replace(/\([^)]*\)/g, '')   // line note
        .trim();
      if (!name) return null;
      return { name, qty: Number(m[1]) || 1 };
    })
    .filter(Boolean);
}

/**
 * Turn whatever the POS posted into line rows.
 *
 * The cart sends a `modifiers` array and prices as either basePrice or price
 * depending on which screen built it, so both are accepted. Quantity is kept as
 * a count on one row rather than exploded into N rows: the kitchen marks "two
 * macchiatos" ready together, and splitting them would ask staff to tick twice
 * for one action.
 */
export function normaliseLines(items) {
  let list = items;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      // Not JSON. The POS also stores a human-readable summary of the order
      // ("1xMacchiato, 1xFut breakfast Gebeta"), and that string is what
      // reached this function for real orders, producing no tracking rows at
      // all. Parsing it is a last resort: it recovers the dish and the
      // quantity, which is enough to time the line, but it cannot recover the
      // menu id or the price.
      list = parseFlatItems(list);
    }
  }
  if (!Array.isArray(list)) return [];

  return list
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const name = String(raw.name || '').trim();
      if (!name) return null;

      const price = raw.basePrice !== undefined ? raw.basePrice : raw.price;
      const qty = Number(raw.qty ?? raw.quantity ?? 1);

      return {
        lineNo: index,
        menuItemId: raw.menuItemId || raw.menu_item_id || raw.id || '',
        name,
        category: raw.category ? String(raw.category) : '',
        qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1,
        unitPrice: Number.isFinite(Number(price)) ? Number(price) : 0,
        modifiers: Array.isArray(raw.modifiers) ? JSON.stringify(raw.modifiers) : '',
        notes: raw.notes ? String(raw.notes) : '',
      };
    })
    .filter(Boolean);
}
