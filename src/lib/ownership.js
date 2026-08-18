/**
 * Who wins when both sides wrote.
 *
 * From the ownership table in LOCAL-SERVER-DESIGN.md. This lives in `src/`
 * rather than in `local/` on purpose: **both sides run this same function**.
 * The box applies what it pulls and the cloud applies what is pushed, and two
 * copies of these rules would drift — silently, and only in the direction that
 * loses data, since a disagreement means one side takes a write the other
 * refused.
 *
 * The rule is symmetric, which is what keeps it honest: an incoming write to
 * an entity the *receiver* owns is never applied. It is a conflict, and goes
 * to the reconciliation list for a human. The locked decision that the manager
 * may use the backoffice on the box during an outage makes this a real path,
 * not a theoretical one — editing a price there writes to a cloud-owned entity
 * and has to surface on reconnect rather than vanish or silently overwrite.
 */

/**
 * - `local` / `cloud`: that side is authoritative.
 * - `creator`: whoever made the row owns it; the two sides write different ids
 *   and simply coexist.
 * - `append`: an immutable log. Inserts union; an update or a delete is a
 *   conflict, because rewriting history is not something either side does.
 */
export const OWNERSHIP = {
  // The room. The box is watching the actual floor; the cloud is guessing.
  tables: 'local',
  timeclock: 'local',

  // Ledgers and logs.
  payments: 'append',
  audit_log: 'append',
  stock_movements: 'append',
  inventory_movements: 'append',

  // Orders coexist by id — an in-venue order and a web order are different
  // rows, and neither side edits the other's during an outage.
  orders: 'creator',
  order_items: 'creator',

  // The outside world, and anything provisioned by a manager.
  reservations: 'cloud',
  menu: 'cloud',
  menu_items: 'cloud',
  categories: 'cloud',
  reviews: 'cloud',
  staff: 'cloud',
  settings: 'cloud',
  content: 'cloud',
};

/**
 * Anything unlisted is cloud-owned.
 *
 * The safe default is that the box does not get to invent authority over a
 * table nobody has thought about: an unrecognised entity written on the box
 * surfaces as a conflict rather than silently overwriting the cloud.
 */
export const DEFAULT_OWNER = 'cloud';

export function ownerOf(entity) {
  return OWNERSHIP[String(entity || '').toLowerCase()] || DEFAULT_OWNER;
}

/**
 * What the receiver should do with one incoming entry.
 *
 * `receiver` is the site applying it — 'local' on the box, 'cloud' on the
 * Worker. Returns:
 *
 * - `apply`    — take the write.
 * - `conflict` — refuse it, and record it for a human. Never silently drop:
 *                that is the exact failure the research warns about with
 *                last-write-wins.
 */
export function decide(entity, op, receiver) {
  const owner = ownerOf(entity);
  const operation = String(op || '').toLowerCase();

  if (owner === 'creator') return 'apply';
  if (owner === 'append') {
    // A log the other side tried to edit rather than extend. Worth a human
    // looking at it, whichever direction it came from.
    return operation === 'insert' ? 'apply' : 'conflict';
  }
  return owner === receiver ? 'conflict' : 'apply';
}

/** Human-readable reason, for the reconciliation row. */
export function reasonFor(entity, op, receiver) {
  const owner = ownerOf(entity);
  if (owner === 'append') {
    return `${entity} is an append-only log; the other side sent an ${op}`;
  }
  return `${entity} is ${owner}-owned and this side is ${receiver}`;
}
