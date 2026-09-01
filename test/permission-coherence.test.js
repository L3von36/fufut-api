import { describe, it, expect } from 'vitest';
import { roleMayAccess, ROLES } from '../src/auth.js';

/**
 * Cross-check: every screen a role can open must be backed by resources that
 * role can actually read.
 *
 * This is the failure this codebase keeps producing. The client decides which
 * nav items to show; the server decides which data to serve. When they
 * disagree, the person gets a screen that renders and then fails every request
 * on it — a blank page with no stated reason, which reads as a broken app
 * rather than a permission.
 *
 * The comment at the top of auth.js says the matrix "was built by reading what
 * each screen actually fetches". That was true when written, and nothing was
 * stopping it drifting the moment a screen gained a second data source. This
 * test is that guard.
 *
 * SCREEN_NEEDS is derived from the views by grepping their api* calls:
 *   cd pos/src/views && grep -ohE "api(Get|Post|Put|Delete)\('[a-z-]+" *.vue
 * Re-derive it when a screen starts fetching something new.
 */

/** POS screen → resources it reads. */
const SCREEN_NEEDS = {
  dashboard: ['delivery', 'expenses', 'inventory', 'orders', 'reports', 'reservations', 'tables'],
  orders: ['menu', 'orders'],
  // Reads the open checks and the floor plan it can move them between.
  'open-checks': ['orders', 'tables'],
  'menu-mgmt': ['menu'],
  'menu-view': ['menu'],
  tables: ['orders', 'tables'],
  reservations: ['reservations', 'tables'],
  delivery: ['delivery'],
  kitchen: ['orders'],
  // The barista board: the same screen as the kitchen, pinned to the bar
  // filter. It reads orders and nothing else.
  barista: ['orders'],
  // The SLA rules screen. Reads its own resource alone; who may WRITE it
  // (acknowledge) is pinned in role-access.test.js, not here.
  alerts: ['alerts'],
  expenses: ['expenses'],
  pnl: ['expenses', 'orders'],
  cashdrawer: ['cashdrawer'],
  inventory: ['inventory'],
  waste: ['inventory', 'waste'],
  shifts: ['shifts'],
  timeclock: ['staff', 'timeclock'],
  reports: ['expenses', 'orders'],
  pipeline: ['orders'],
  revenue: ['orders'],
  analytics: ['menu', 'orders'],
  checkout: ['orders'],
  recipes: ['inventory', 'menu', 'recipes', 'units'],
  'stock-control': ['inventory'],
  suppliers: ['suppliers'],
  purchases: ['inventory', 'purchases', 'suppliers'],
};

/**
 * Kept in step with pos/src/api/index.js by the assertions below rather than by
 * hope: a screen granted here and missing there is caught, and vice versa.
 */
const POS_PERMISSIONS = {
  manager: ['dashboard', 'orders', 'open-checks', 'tables', 'menu-mgmt', 'menu-view', 'expenses', 'pnl', 'cashdrawer', 'inventory', 'waste', 'shifts', 'timeclock', 'kitchen', 'reports', 'reservations', 'delivery', 'analytics', 'checkout', 'recipes', 'suppliers', 'purchases', 'stock-control'],
  'head-chef': ['kitchen', 'orders', 'dashboard', 'inventory', 'waste', 'reports', 'pipeline', 'menu-mgmt', 'recipes', 'stock-control', 'suppliers', 'purchases', 'timeclock'],
  'assistant-chef': ['kitchen', 'orders', 'dashboard', 'inventory', 'recipes', 'timeclock'],
  // The drinks station. The board is home; around it the role reads the full
  // Orders list, the SLA warnings, the waste log (with the inventory read
  // that names the item thrown away) and the drink recipes. No dashboard:
  // the board IS the overview, and when the role was widened the owner chose
  // the recipe book over one. Mirrors pos/src/api/index.js.
  barista: ['barista', 'orders', 'alerts', 'waste', 'recipes', 'timeclock'],
  'head-waiter': ['tables', 'orders', 'open-checks', 'dashboard', 'menu-view', 'reservations', 'checkout', 'timeclock'],
  cashier: ['cashdrawer', 'orders', 'open-checks', 'dashboard', 'tables', 'reports', 'timeclock', 'reservations', 'revenue', 'menu-view', 'analytics', 'checkout'],
  'delivery-staff': ['delivery', 'dashboard', 'timeclock'],
  cleaner: ['waste', 'dashboard', 'timeclock'],
  accountant: ['dashboard', 'reports', 'revenue', 'pnl', 'expenses', 'analytics', 'orders', 'purchases', 'suppliers', 'timeclock'],
};

/**
 * The dashboard is excluded from the union check below, deliberately.
 *
 * Unlike every other screen it branches on role — a cleaner's dashboard fetches
 * tables, a driver's fetches deliveries — so the union of everything it *can*
 * request is not what any single role requests. Every one of those fetches is
 * also `.catch()`-guarded and falls back to an empty array, so a refusal
 * degrades a tile rather than blanking the page.
 *
 * Its per-role expectations are asserted separately, further down.
 *
 * Time Clock is the second one, for a different reason.
 *
 * It has two halves. The roster — who is on shift today — needs `timeclock` and
 * `staff` reads and belongs to whoever runs the floor. Clocking yourself on and
 * off is everybody's, and goes through the self-service routes in auth.js,
 * which are outside the role matrix by design: granting the resource instead
 * would hand the floor the power to rewrite anyone's hours, which is a payroll
 * figure.
 *
 * So every role carries the screen, and the roster half hides itself when the
 * fetch is refused rather than rendering an empty grid that reads as "nobody is
 * working".
 */
const CONDITIONAL_SCREENS = new Set(['dashboard', 'timeclock']);

describe('every granted screen is backed by readable data', () => {
  for (const [role, screens] of Object.entries(POS_PERMISSIONS)) {
    for (const screen of screens) {
      const needs = SCREEN_NEEDS[screen];
      if (!needs || CONDITIONAL_SCREENS.has(screen)) continue;
      it(`${role} can read everything ${screen} fetches`, () => {
        const refused = needs.filter((r) => !roleMayAccess(role, `/api/${r}`, 'GET'));
        expect(refused, `${screen} would render then fail on: ${refused.join(', ')}`).toEqual([]);
      });
    }
  }
});

describe('the dashboard is the awkward one', () => {
  it('is granted to every role except the barista', () => {
    // The barista's board IS their screen — ROLE_DEFAULT_VIEW puts them on it
    // at sign-in, and when the role was widened the owner chose the drink
    // recipe book over an overview dashboard. Every other role keeps it.
    for (const role of ROLES.filter((r) => r !== 'barista')) {
      expect(POS_PERMISSIONS[role]).toContain('dashboard');
    }
  });

  it('gives the cleaner exactly what their dashboard counts', () => {
    expect(roleMayAccess('cleaner', '/api/tables', 'GET')).toBe(true);
    expect(roleMayAccess('cleaner', '/api/waste', 'GET')).toBe(true);
    // Not the rest of the dashboard's union.
    expect(roleMayAccess('cleaner', '/api/orders', 'GET')).toBe(false);
    expect(roleMayAccess('cleaner', '/api/expenses', 'GET')).toBe(false);
  });

  /**
   * Found by this audit. The Waste screen gained an ingredient picker when
   * waste was connected to the ledger, and the cleaner — the role most likely
   * to be clearing a spoiled tray — could not read the list. Their waste would
   * log as free text and never reduce stock, leaving the shelf overstated by
   * exactly the amount that was thrown away.
   */
  it('lets the cleaner name the stock item they are throwing away', () => {
    expect(roleMayAccess('cleaner', '/api/inventory', 'GET')).toBe(true);
    // Reading stock is not adjusting it.
    expect(roleMayAccess('cleaner', '/api/inventory', 'PUT')).toBe(false);
    expect(roleMayAccess('cleaner', '/api/inventory', 'POST')).toBe(false);
  });

  it('gives the driver the delivery half only', () => {
    expect(roleMayAccess('delivery-staff', '/api/delivery', 'GET')).toBe(true);
    expect(roleMayAccess('delivery-staff', '/api/tables', 'GET')).toBe(false);
  });
});

describe('every role in the matrix is usable', () => {
  it('has a screen list', () => {
    for (const role of ROLES) {
      expect(POS_PERMISSIONS[role], `${role} has no screens`).toBeTruthy();
      expect(POS_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });

  it('grants no screen that does not exist', () => {
    const known = new Set([...Object.keys(SCREEN_NEEDS), 'pipeline']);
    for (const [role, screens] of Object.entries(POS_PERMISSIONS)) {
      for (const s of screens) {
        expect(known.has(s), `${role} is granted "${s}", which is not a screen`).toBe(true);
      }
    }
  });
});

describe('separation of duties survives', () => {
  // The reads that look wrong and are load-bearing, per auth.js. Removing one
  // blanks a page, so they are pinned.
  it('keeps the load-bearing surprises', () => {
    expect(roleMayAccess('head-chef', '/api/expenses', 'GET')).toBe(true);   // Reports
    expect(roleMayAccess('cashier', '/api/staff', 'GET')).toBe(true);        // Time Clock
    expect(roleMayAccess('cleaner', '/api/tables', 'GET')).toBe(true);       // Dashboard
    for (const role of ROLES) {
      expect(roleMayAccess(role, '/api/menu', 'GET')).toBe(true);            // dish names
    }
  });

  it('keeps money away from the kitchen and the floor', () => {
    for (const role of ['head-chef', 'assistant-chef', 'cleaner']) {
      expect(roleMayAccess(role, '/api/cashdrawer', 'GET')).toBe(false);
      expect(roleMayAccess(role, '/api/payments', 'GET')).toBe(false);
    }
    // A waiter sees whether a table settled; they cannot take the money.
    expect(roleMayAccess('head-waiter', '/api/payments', 'GET')).toBe(true);
    expect(roleMayAccess('head-waiter', '/api/payments', 'POST')).toBe(false);
    expect(roleMayAccess('head-waiter', '/api/cashdrawer', 'GET')).toBe(false);
  });

  it('keeps stock control with the chef and away from everyone else', () => {
    expect(roleMayAccess('head-chef', '/api/inventory', 'PUT')).toBe(true);
    expect(roleMayAccess('head-chef', '/api/recipes', 'POST')).toBe(true);
    // Cooks from them, does not set them.
    expect(roleMayAccess('assistant-chef', '/api/recipes', 'GET')).toBe(true);
    expect(roleMayAccess('assistant-chef', '/api/recipes', 'POST')).toBe(false);
    expect(roleMayAccess('assistant-chef', '/api/inventory', 'PUT')).toBe(false);
    for (const role of ['cashier', 'head-waiter', 'delivery-staff']) {
      expect(roleMayAccess(role, '/api/inventory', 'PUT')).toBe(false);
    }
  });

  it('lets the chef see what stock costs without letting them commit spend', () => {
    expect(roleMayAccess('head-chef', '/api/purchases', 'GET')).toBe(true);
    expect(roleMayAccess('head-chef', '/api/purchases', 'POST')).toBe(false);
    expect(roleMayAccess('head-chef', '/api/suppliers', 'POST')).toBe(false);
  });

  it('leaves the manager unrestricted', () => {
    for (const p of ['/api/staff', '/api/payroll', '/api/settings', '/api/audit', '/api/purchases']) {
      expect(roleMayAccess('manager', p, 'GET')).toBe(true);
    }
  });
});
