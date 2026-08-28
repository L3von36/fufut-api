import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoCompleteStaleOrders } from '../src/handlers/orders.js';

/**
 * Auto-close of paid tickets nobody closed.
 *
 * The sweep exists because the end of a busy service is when the manual last
 * step — closing a ticket — gets skipped, and production carried four such
 * rows at once. The tests pin the guards that make the sweep safe to run
 * unattended: paid only, never delivery, never unmade food, a manager-owned
 * threshold with an off switch, and a conditional update that loses gracefully
 * when a waiter closes the same ticket a moment earlier.
 *
 * D1 fake keyed on the shape of the SQL, matching orders-transfer.test.js.
 * outboxCapture is inert because the fake env carries no SITE_ID.
 */
function makeEnv({ settingsValue = null, settingsThrow = false, candidateRows = [], updateChanges = 1 } = {}) {
  const run = vi.fn().mockResolvedValue({ meta: { changes: updateChanges } });
  const bound = [];
  const prepare = vi.fn(function (sql) {
    return {
      bind: (...params) => {
        bound.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return {
          all: async () => {
            if (settingsThrow && /FROM settings/.test(sql)) {
              throw new Error('no such table: settings');
            }
            if (/FROM settings/.test(sql)) {
              return { results: settingsValue === null ? [] : [{ value: settingsValue }] };
            }
            if (/FROM orders/.test(sql)) return { results: candidateRows };
            return { results: [] };
          },
          run,
        };
      },
    };
  });
  return { DB: { prepare } , _run: run, _bound: bound };
}

// Deterministic clock: 2026-08-28T12:00:00.000Z
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('autoCompleteStaleOrders', () => {
  it('closes an old served+paid order, advances its lines, and writes an audit entry', async () => {
    const env = makeEnv({
      candidateRows: [
        { id: 'Ostale1', status: 'served', payment_status: 'paid', type: 'dine-in',
          served_at: '2026-08-28T02:00:00.000Z', ready_at: '2026-08-28T01:40:00.000Z' },
      ],
    });
    const r = await autoCompleteStaleOrders(env, NOW);

    expect(r.closed).toBe(1);
    expect(r.thresholdMin).toBe(240);

    const updates = env._bound.filter((b) => /UPDATE orders SET status = 'completed'/.test(b.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(['2026-08-28T12:00:00.000Z', 'Ostale1']);

    const lineUpdates = env._bound.filter((b) => /UPDATE order_items SET status = 'served'/.test(b.sql));
    expect(lineUpdates).toHaveLength(1);
    expect(lineUpdates[0].params[1]).toBe('Ostale1');

    const audits = env._bound.filter((b) => /INSERT INTO audit_log/.test(b.sql));
    expect(audits).toHaveLength(1);
    // audit_log columns: id, at, actor_id, actor_name, actor_role, action,
    // entity, entity_id, before, after, reason
    const [, , actorId, actorName, actorRole, action, entity, entityId] = audits[0].params;
    expect(actorId).toBe('system');
    expect(actorName).toBe('SLA Sweep');
    expect(actorRole).toBe('system');
    expect(action).toBe('update');
    expect(entity).toBe('orders');
    expect(entityId).toBe('Ostale1');
    // The reason names the setting, so the manager can retrace the decision.
    expect(audits[0].params[10]).toContain('orders.autocomplete_min=240');
  });

  it('reads the threshold from settings and computes the cutoff from it', async () => {
    const env = makeEnv({ settingsValue: '60' });
    await autoCompleteStaleOrders(env, NOW);

    expect(env._bound[0].params).toEqual(['orders.autocomplete_min']);
    const select = env._bound.find((b) => /FROM orders/.test(b.sql));
    expect(select.params[0]).toBe('2026-08-28T11:00:00.000Z'); // now - 60 min
  });

  it('an explicit 0 in settings turns the sweep off without touching orders', async () => {
    const env = makeEnv({ settingsValue: '0' });
    const r = await autoCompleteStaleOrders(env, NOW);

    expect(r).toEqual({ closed: 0, disabled: true });
    expect(env._bound.filter((b) => /UPDATE/.test(b.sql))).toHaveLength(0);
  });

  it('falls back to the default threshold when the settings table is missing', async () => {
    const env = makeEnv({ settingsThrow: true });
    const r = await autoCompleteStaleOrders(env, NOW);

    expect(r.thresholdMin).toBe(240);
    const select = env._bound.find((b) => /FROM orders/.test(b.sql));
    expect(select.params[0]).toBe('2026-08-28T08:00:00.000Z'); // now - 240 min
  });

  // Number('') is 0, not NaN: an absent settings row once collapsed the
  // threshold to zero, which is 'disabled' — the sweep shipped off by default.
  it('an empty settings row keeps the default instead of disabling the sweep', async () => {
    const env = makeEnv({ settingsValue: '' });
    const r = await autoCompleteStaleOrders(env, NOW);

    expect(r.disabled).toBeUndefined();
    expect(r.thresholdMin).toBe(240);
  });

  it('an unparseable settings row keeps the default', async () => {
    const env = makeEnv({ settingsValue: 'four hours' });
    const r = await autoCompleteStaleOrders(env, NOW);

    expect(r.thresholdMin).toBe(240);
  });

  it('only ever selects tickets that are paid, made, not delivery and not voided', async () => {
    const env = makeEnv({ candidateRows: [] });
    await autoCompleteStaleOrders(env, NOW);

    const sql = env._bound.find((b) => /FROM orders/.test(b.sql)).sql;
    expect(sql).toContain("status IN ('ready', 'served')");
    expect(sql).toContain("payment_status = 'paid'");
    expect(sql).toContain("COALESCE(type, '') <> 'delivery'");
    expect(sql).toContain("COALESCE(voided_at, '') = ''");
  });

  it('a conditional update that loses (waiter closed it first) writes no audit entry', async () => {
    const env = makeEnv({
      candidateRows: [
        { id: 'Oraced1', status: 'served', payment_status: 'paid', type: 'takeaway' },
      ],
      updateChanges: 0,
    });
    const r = await autoCompleteStaleOrders(env, NOW);

    expect(r.closed).toBe(0);
    const lineUpdates = env._bound.filter((b) => /UPDATE order_items/.test(b.sql));
    expect(lineUpdates).toHaveLength(0);
    expect(env._bound.filter((b) => /INSERT INTO audit_log/.test(b.sql))).toHaveLength(0);
  });
});
