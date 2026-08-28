import { describe, it, expect } from 'vitest';
import {
  ageMinutes,
  fmtMin,
  orderLabel,
  evaluateOrder,
  evaluateOrders,
  evaluateDeliveryJob,
  evaluateReservation,
  evaluateTable,
  evaluateAll,
  dedupeKey,
  RULE_IDS,
  RULE_DEFAULTS,
  SEVERITY,
} from '../src/lib/rules.js';

const NOW = Date.parse('2026-08-28T18:00:00.000Z');
const minAgo = (m) => new Date(NOW - m * 60000).toISOString();

/**
 * The rules are the arguments the floor will have. "How late is late" is a
 * business opinion wearing a constant, so every boundary here is tested from
 * both sides: one minute under is silence, one minute over is an alert. A
 * rule that fires early burns trust; one that fires late burns food.
 */
describe('ageMinutes / fmtMin', () => {
  it('measures minutes from an ISO stamp', () => {
    expect(ageMinutes(minAgo(30), NOW)).toBeCloseTo(30, 5);
  });

  it('returns null for an unreadable stamp rather than guessing', () => {
    expect(ageMinutes('', NOW)).toBeNull();
    expect(ageMinutes(null, NOW)).toBeNull();
    expect(ageMinutes('not a date', NOW)).toBeNull();
  });

  it('never reports a negative age for a stamp in the future', () => {
    expect(ageMinutes(new Date(NOW + 5 * 60000).toISOString(), NOW)).toBe(0);
  });

  it('speaks in minutes under the hour and hours over it', () => {
    expect(fmtMin(18)).toBe('18 min');
    expect(fmtMin(72.4)).toBe('1 h 12 min');
    expect(fmtMin(NaN)).toBe('?');
  });
});

describe('orderLabel', () => {
  it('leads with the table when there is one', () => {
    expect(orderLabel({ table_id: '7' })).toBe('Table 7');
    expect(orderLabel({ table_number: '03' })).toBe('Table 03');
  });

  it('names the order kind when there is no table', () => {
    expect(orderLabel({ source: 'qr' })).toBe('QR order');
    expect(orderLabel({ type: 'takeaway' })).toBe('Takeaway order');
    expect(orderLabel({ type: 'delivery' })).toBe('Delivery order');
    expect(orderLabel({})).toBe('Order');
  });
});

describe('order-preparing-too-long', () => {
  const order = (over = {}) => ({
    id: 'O1',
    status: 'preparing',
    table_id: '5',
    created: minAgo(3),
    preparing_at: minAgo(25),
    ...over,
  });

  it('is silent one minute under the warning', () => {
    expect(evaluateOrder(order({ preparing_at: minAgo(20) }), NOW)).toBeNull();
  });

  it('warns one minute over', () => {
    const v = evaluateOrder(order(), NOW);
    expect(v.rule_id).toBe(RULE_IDS.PREPARING_TOO_LONG);
    expect(v.severity).toBe(SEVERITY.WARNING);
    expect(v.message).toContain('Table 5');
    expect(v.message).toContain('25 min');
  });

  it('goes critical past the critical threshold', () => {
    const v = evaluateOrder(order({ preparing_at: minAgo(41) }), NOW);
    expect(v.severity).toBe(SEVERITY.CRITICAL);
  });

  it('reads the preparing clock, not the created clock', () => {
    // The order existed for two hours but only started cooking eight minutes
    // ago — a rush of new tickets, not a lost one.
    expect(evaluateOrder(order({ created: minAgo(120), preparing_at: minAgo(8) }), NOW)).toBeNull();
  });

  it('falls back to updated_at when preparing_at was never stamped', () => {
    const v = evaluateOrder(order({ preparing_at: null, updated_at: minAgo(35) }), NOW);
    expect(v).not.toBeNull();
    expect(v.message).toContain('35 min');
  });

  it('honours threshold overrides from settings', () => {
    const th = { ...RULE_DEFAULTS, preparingWarnMin: 10 };
    expect(evaluateOrder(order({ preparing_at: minAgo(12) }), NOW, th)).not.toBeNull();
    expect(evaluateOrder(order({ preparing_at: minAgo(12) }), NOW, { ...th, preparingWarnMin: 15 })).toBeNull();
  });
});

describe('order-new-unaccepted', () => {
  const order = (over = {}) => ({
    id: 'O2',
    status: 'new',
    source: 'qr',
    created: minAgo(2),
    ...over,
  });

  it('is silent inside the acceptance window', () => {
    expect(evaluateOrder(order({ created: minAgo(5) }), NOW)).toBeNull();
  });

  it('raises when nobody has accepted in time', () => {
    const v = evaluateOrder(order({ created: minAgo(6) }), NOW);
    expect(v.rule_id).toBe(RULE_IDS.NEW_UNACCEPTED);
    expect(v.entity_label).toBe('QR order');
    expect(v.message).toContain('nobody has accepted it');
  });
});

describe('order-ready-not-served', () => {
  const order = (over = {}) => ({
    id: 'O3',
    status: 'ready',
    table_id: '2',
    ready_at: minAgo(11),
    ...over,
  });

  it('raises when food sits ready past the limit', () => {
    const v = evaluateOrder(order(), NOW);
    expect(v.rule_id).toBe(RULE_IDS.READY_NOT_SERVED);
    expect(v.message).toContain('food ready 11 min');
  });

  it('leaves delivery orders to the delivery rules', () => {
    // A delivery ticket going ready means "waiting for a rider", which is a
    // different question with a different clock and its own rule.
    expect(evaluateOrder(order({ type: 'delivery' }), NOW)).toBeNull();
  });

  it('is silent within the limit', () => {
    expect(evaluateOrder(order({ ready_at: minAgo(10) }), NOW)).toBeNull();
  });
});

describe('order-served-unpaid', () => {
  const order = (over = {}) => ({
    id: 'O4',
    status: 'served',
    table_id: '9',
    served_at: minAgo(35),
    payment_status: 'unpaid',
    ...over,
  });

  it('raises when the bill is still open half an hour after service', () => {
    const v = evaluateOrder(order(), NOW);
    expect(v.rule_id).toBe(RULE_IDS.SERVED_UNPAID);
    expect(v.message).toContain('bill still open');
  });

  it('says nothing once the money is taken', () => {
    expect(evaluateOrder(order({ payment_status: 'paid' }), NOW)).toBeNull();
  });

  it('still watches a partly paid ticket', () => {
    expect(evaluateOrder(order({ payment_status: 'partial' }), NOW)).not.toBeNull();
  });

  it('matches the fulfilled spelling of a finished order', () => {
    expect(evaluateOrder(order({ status: 'fulfilled' }), NOW)).not.toBeNull();
  });
});

describe('delivery rules', () => {
  const job = (over = {}) => ({
    id: 'D1',
    customer: 'Selam W.',
    status: 'ready',
    driver_id: null,
    updated_at: minAgo(12),
    created: minAgo(40),
    ...over,
  });

  it('raises when food is ready with no driver named', () => {
    const v = evaluateDeliveryJob(job(), NOW);
    expect(v.rule_id).toBe(RULE_IDS.DELIVERY_UNASSIGNED);
    expect(v.message).toContain('no driver assigned');
  });

  it('is silent once a driver is assigned', () => {
    expect(evaluateDeliveryJob(job({ driver_id: 'S9' }), NOW)).toBeNull();
  });

  it('allows assignment to lag while the food is still cooking', () => {
    expect(evaluateDeliveryJob(job({ status: 'preparing' }), NOW)).toBeNull();
  });

  it('raises when a driver has been out too long', () => {
    const v = evaluateDeliveryJob(job({ status: 'out_for_delivery', updated_at: minAgo(46) }), NOW);
    expect(v.rule_id).toBe(RULE_IDS.DELIVERY_IN_TRANSIT);
    expect(v.message).toContain('out for delivery 46 min');
  });

  it('clocks picked_up from the pickup stamp', () => {
    const v = evaluateDeliveryJob(
      job({ status: 'picked_up', picked_up_at: minAgo(50), updated_at: minAgo(5) }),
      NOW
    );
    expect(v).not.toBeNull();
    expect(v.message).toContain('picked up 50 min');
  });

  it('is silent for a delivery that just left', () => {
    expect(evaluateDeliveryJob(job({ status: 'out_for_delivery', updated_at: minAgo(45) }), NOW)).toBeNull();
  });
});

describe('reservation-no-show', () => {
  const reservation = (over = {}) => ({
    id: 'R1',
    name: 'Amanuel',
    guests: 4,
    date: '2026-08-28',
    time: '17:30',
    status: 'confirmed',
    start_at: minAgo(16),
    end_at: minAgo(-74),
    ...over,
  });

  it('raises once the grace period is blown and nobody sat down', () => {
    const v = evaluateReservation(reservation(), NOW);
    expect(v.rule_id).toBe(RULE_IDS.RESERVATION_NO_SHOW);
    expect(v.entity_type).toBe('reservation');
    expect(v.message).toContain('4 guests');
  });

  it('reuses the booking module inside its grace window', () => {
    expect(evaluateReservation(reservation({ start_at: minAgo(15) }), NOW)).toBeNull();
  });

  it('says nothing once staff have marked the no-show', () => {
    expect(evaluateReservation(reservation({ no_show_at: minAgo(1) }), NOW)).toBeNull();
  });

  it('says nothing about a party already released to a table', () => {
    expect(evaluateReservation(reservation({ released_at: minAgo(10) }), NOW)).toBeNull();
  });
});

describe('table-seated-too-long', () => {
  const table = (over = {}) => ({
    id: '5',
    name: '5',
    status: 'occupied',
    guests: 3,
    seated_at: minAgo(95),
    ...over,
  });

  it('raises at the turnover limit', () => {
    const v = evaluateTable(table(), NOW);
    expect(v.rule_id).toBe(RULE_IDS.TABLE_SEATED_TOO_LONG);
    expect(v.entity_type).toBe('table');
    expect(v.message).toContain('1 h 35 min');
    expect(v.message).toContain('(3 guests)');
  });

  it('is silent under the limit, and for a free table', () => {
    expect(evaluateTable(table({ seated_at: minAgo(90) }), NOW)).toBeNull();
    expect(evaluateTable(table({ status: 'available' }), NOW)).toBeNull();
  });

  it('does not judge a table with no seating stamp', () => {
    // The same rule staleness.js follows: guessing an age would either free a
    // live table or never free a dead one.
    expect(evaluateTable(table({ seated_at: null }), NOW)).toBeNull();
  });
});

describe('evaluateAll + dedupeKey', () => {
  it('collects violations across every entity kind in one pass', () => {
    const found = evaluateAll(
      {
        orders: [
          { id: 'O1', status: 'preparing', table_id: '5', preparing_at: minAgo(50) },
          { id: 'O2', status: 'completed' },
        ],
        deliveryJobs: [{ id: 'D1', customer: 'X', status: 'ready', driver_id: null, updated_at: minAgo(20) }],
        reservations: [
          { id: 'R1', name: 'N', status: 'confirmed', start_at: minAgo(30), end_at: minAgo(-60) },
        ],
        tables: [{ id: '7', name: '7', status: 'occupied', seated_at: minAgo(200) }],
      },
      NOW
    );
    const rules = found.map((v) => v.rule_id);
    expect(rules).toContain(RULE_IDS.PREPARING_TOO_LONG);
    expect(rules).toContain(RULE_IDS.DELIVERY_UNASSIGNED);
    expect(rules).toContain(RULE_IDS.RESERVATION_NO_SHOW);
    expect(rules).toContain(RULE_IDS.TABLE_SEATED_TOO_LONG);
    expect(found).toHaveLength(4);
  });

  it('keys on rule + entity type + entity id, stably', () => {
    const v = { rule_id: 'r', entity_type: 'order', entity_id: 'O1' };
    expect(dedupeKey(v)).toBe('r|order|O1');
    expect(dedupeKey({ ...v, entity_id: 7 })).toBe('r|order|7');
  });
});
