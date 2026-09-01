import { describe, it, expect } from 'vitest';
import { roleMayAccess, resourceForPath, actorName, isPrivateImage, isSessionRoute } from '../src/auth.js';

const GET = 'GET';
const POST = 'POST';
const PUT = 'PUT';
const DELETE = 'DELETE';

const ROLES = [
  'manager',
  'head-chef',
  'assistant-chef',
  'barista',
  'head-waiter',
  'cashier',
  'delivery-staff',
  'cleaner',
];

describe('resourceForPath', () => {
  it('reads the resource from an ordinary path', () => {
    expect(resourceForPath('/api/orders')).toBe('orders');
    expect(resourceForPath('/api/orders/O123')).toBe('orders');
    expect(resourceForPath('/api/orders/O123/items/OI1')).toBe('orders');
    expect(resourceForPath('/api/staff')).toBe('staff');
  });

  // These are the paths that do not name their resource plainly, and each one
  // would be a hole if it fell through as unknown.
  it('normalises the paths that do not name their resource', () => {
    expect(resourceForPath('/api/menus')).toBe('menu');
    expect(resourceForPath('/api/menus/save')).toBe('menu');
    expect(resourceForPath('/api/save-content')).toBe('content');
  });

  it('gates each SSE stream as the data it pushes', () => {
    expect(resourceForPath('/api/events/kitchen')).toBe('orders');
    expect(resourceForPath('/api/events/tables')).toBe('tables');
  });

  it('returns null for anything that is not an API resource', () => {
    expect(resourceForPath('/')).toBeNull();
    expect(resourceForPath('/api')).toBeNull();
    expect(resourceForPath('')).toBeNull();
    expect(resourceForPath(null)).toBeNull();
  });
});

describe('manager', () => {
  it('may reach every resource, read and write', () => {
    for (const p of ['/api/staff', '/api/expenses', '/api/cashdrawer', '/api/tables', '/api/shifts', '/api/waste']) {
      expect(roleMayAccess('manager', p, GET)).toBe(true);
      expect(roleMayAccess('manager', p, POST)).toBe(true);
      expect(roleMayAccess('manager', p, DELETE)).toBe(true);
    }
  });

  it('is matched however the role is spelled in the session', () => {
    expect(roleMayAccess('Manager', '/api/staff', GET)).toBe(true);
    expect(roleMayAccess('MANAGER', '/api/staff', GET)).toBe(true);
  });
});

describe('head chef', () => {
  it('reaches the kitchen and stock resources it works with', () => {
    for (const p of ['/api/orders', '/api/inventory', '/api/waste']) {
      expect(roleMayAccess('head-chef', p, GET)).toBe(true);
      expect(roleMayAccess('head-chef', p, PUT)).toBe(true);
    }
  });

  // Load-bearing: Reports fetches expenses unconditionally, so removing this
  // read blanks the chef's Reports screen.
  it('may read expenses because Reports needs them, but may not write them', () => {
    expect(roleMayAccess('head-chef', '/api/expenses', GET)).toBe(true);
    expect(roleMayAccess('head-chef', '/api/expenses', POST)).toBe(false);
  });

  it('may read the menu, which every order screen renders', () => {
    expect(roleMayAccess('head-chef', '/api/menu', GET)).toBe(true);
    expect(roleMayAccess('head-chef', '/api/menus', GET)).toBe(true);
  });

  it('may not change the menu', () => {
    expect(roleMayAccess('head-chef', '/api/menus/save', POST)).toBe(false);
  });

  // The exact leak this enforcement was written for: all four returned 200.
  it('is refused the screens the UI hides from it', () => {
    expect(roleMayAccess('head-chef', '/api/staff', GET)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/cashdrawer', GET)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/tables', GET)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/shifts', GET)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/timeclock', GET)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/reservations', GET)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/delivery', GET)).toBe(false);
  });

  it('may subscribe to the kitchen stream but not the floor stream', () => {
    expect(roleMayAccess('head-chef', '/api/events/kitchen', GET)).toBe(true);
    expect(roleMayAccess('head-chef', '/api/events/tables', GET)).toBe(false);
  });
});

// The drinks station. The board rides on plain orders read/write; the
// supporting screens (orders list, alerts, waste, recipes) landed when the
// role was widened, each read-shaped — the write set is still just the board
// plus the waste log.
describe('barista', () => {
  it('keeps the board and reads the whole ticket list', () => {
    expect(roleMayAccess('barista', '/api/orders', GET)).toBe(true);
    expect(roleMayAccess('barista', '/api/orders', PUT)).toBe(true);
    // `tables` feeds the Orders screen's table filter — the same
    // load-bearing read the cleaner's dashboard needs.
    expect(roleMayAccess('barista', '/api/tables', GET)).toBe(true);
    expect(roleMayAccess('barista', '/api/tables', PUT)).toBe(false);
  });

  it('reads the SLA warnings but does not sign them off', () => {
    expect(roleMayAccess('barista', '/api/alerts', GET)).toBe(true);
    // Same treatment as the assistant-chef: the ticket going late is theirs
    // to rescue; acknowledging it stays with the chefs, the floor leads and
    // the manager.
    expect(roleMayAccess('barista', '/api/alerts/AL1/acknowledge', POST)).toBe(false);
  });

  it('logs waste against the stock list without adjusting stock', () => {
    expect(roleMayAccess('barista', '/api/waste', GET)).toBe(true);
    expect(roleMayAccess('barista', '/api/waste', POST)).toBe(true);
    // The stock list is what lets a wasted carton of milk name the item —
    // the cleaner's exact treatment. Reading stock is not adjusting it.
    expect(roleMayAccess('barista', '/api/inventory', GET)).toBe(true);
    expect(roleMayAccess('barista', '/api/inventory', PUT)).toBe(false);
    expect(roleMayAccess('barista', '/api/inventory', POST)).toBe(false);
  });

  it('brews from recipes it cannot write', () => {
    expect(roleMayAccess('barista', '/api/recipes', GET)).toBe(true);
    expect(roleMayAccess('barista', '/api/recipes', POST)).toBe(false);
  });

  it('cannot 86 a drink — that stays with the chefs and the manager', () => {
    expect(roleMayAccess('barista', '/api/menu/MI123/availability', PUT)).toBe(false);
  });

  it('is still refused money and colleague data', () => {
    for (const p of ['/api/payments', '/api/tips', '/api/cashdrawer', '/api/expenses', '/api/staff', '/api/audit', '/api/payroll', '/api/leave']) {
      expect(roleMayAccess('barista', p, GET)).toBe(false);
    }
  });
});

describe('assistant chef', () => {
  it('is narrower than the head chef', () => {
    expect(roleMayAccess('assistant-chef', '/api/orders', GET)).toBe(true);
    expect(roleMayAccess('assistant-chef', '/api/inventory', GET)).toBe(true);
    // No Reports screen, so no reason to read expenses.
    expect(roleMayAccess('assistant-chef', '/api/expenses', GET)).toBe(false);
    expect(roleMayAccess('assistant-chef', '/api/waste', GET)).toBe(false);
  });

  // Stock control is the head chef's duty. An assistant works against the
  // counts rather than setting them, so they read the figures and no more.
  it('reads stock but may not change it', () => {
    expect(roleMayAccess('assistant-chef', '/api/inventory', GET)).toBe(true);
    expect(roleMayAccess('assistant-chef', '/api/inventory', PUT)).toBe(false);
    expect(roleMayAccess('assistant-chef', '/api/inventory', POST)).toBe(false);
    expect(roleMayAccess('assistant-chef', '/api/inventory', DELETE)).toBe(false);
  });
});

// Regression: every audited action - releasing a table, overriding a booking,
// 86ing a dish - recorded the literal string "unknown", because the helper read
// auth.name / auth.id / auth.email and getAuthUser returns none of those. A
// wrong name in an audit trail is worse than a blank one, because it reads as
// an answer.
describe('actorName', () => {
  it('names the person from the session', () => {
    expect(actorName({ staff_id: 'S2', firstName: 'Selam', lastName: 'Wondimu' })).toBe('Selam Wondimu');
  });

  it('copes with a partial name', () => {
    expect(actorName({ staff_id: 'S2', firstName: 'Selam' })).toBe('Selam');
    expect(actorName({ staff_id: 'S2', lastName: 'Wondimu' })).toBe('Wondimu');
  });

  it('falls back to the staff id rather than inventing a name', () => {
    expect(actorName({ staff_id: 'S2' })).toBe('S2');
  });

  it('never returns the fields it used to read by mistake', () => {
    // auth.name and auth.email are not on the session object at all.
    expect(actorName({ staff_id: 'S7', name: 'ignored', email: 'ignored@x' })).toBe('S7');
  });

  it('handles a missing session', () => {
    expect(actorName(null)).toBe('unknown');
    expect(actorName(undefined)).toBe('unknown');
  });
});

describe('86ing a dish', () => {
  const AVAIL = '/api/menu/MI123/availability';

  it('is its own resource, distinct from the menu', () => {
    expect(resourceForPath(AVAIL)).toBe('menu-availability');
    expect(resourceForPath('/api/menu/MI123')).toBe('menu');
    expect(resourceForPath('/api/menu')).toBe('menu');
  });

  // Running out mid-service is a kitchen fact, so the chef must be able to stop
  // the POS selling a dish.
  it('is allowed to the head chef and the manager', () => {
    expect(roleMayAccess('head-chef', AVAIL, PUT)).toBe(true);
    expect(roleMayAccess('manager', AVAIL, PUT)).toBe(true);
  });

  // The point of the split: the grant must not widen into repricing.
  it('does not give the head chef the menu itself', () => {
    expect(roleMayAccess('head-chef', '/api/menu/MI123', PUT)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/menu', POST)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/menu/MI123', DELETE)).toBe(false);
    expect(roleMayAccess('head-chef', '/api/menus/save', POST)).toBe(false);
  });

  it('is refused to every other role', () => {
    for (const r of ['assistant-chef', 'barista', 'head-waiter', 'cashier', 'cleaner', 'delivery-staff']) {
      expect(roleMayAccess(r, AVAIL, PUT)).toBe(false);
    }
  });
});

describe('stock control follows the head chef', () => {
  it('lets the head chef change stock, which is the duty the role is defined by', () => {
    expect(roleMayAccess('head-chef', '/api/inventory', GET)).toBe(true);
    expect(roleMayAccess('head-chef', '/api/inventory', PUT)).toBe(true);
    expect(roleMayAccess('head-chef', '/api/inventory', POST)).toBe(true);
  });

  it('grants stock writes to nobody else outside the manager', () => {
    for (const r of ['head-waiter', 'cashier', 'cleaner', 'delivery-staff', 'assistant-chef', 'barista']) {
      expect(roleMayAccess(r, '/api/inventory', PUT)).toBe(false);
    }
    expect(roleMayAccess('manager', '/api/inventory', PUT)).toBe(true);
  });
});

describe('head waiter', () => {
  it('reaches the floor resources', () => {
    for (const p of ['/api/orders', '/api/tables', '/api/reservations']) {
      expect(roleMayAccess('head-waiter', p, GET)).toBe(true);
      expect(roleMayAccess('head-waiter', p, POST)).toBe(true);
    }
  });

  it('is refused finance, stock and colleague data', () => {
    for (const p of ['/api/expenses', '/api/cashdrawer', '/api/inventory', '/api/staff', '/api/waste', '/api/shifts']) {
      expect(roleMayAccess('head-waiter', p, GET)).toBe(false);
    }
  });
});

describe('cashier', () => {
  it('reaches the till and the floor', () => {
    for (const p of ['/api/cashdrawer', '/api/orders', '/api/tables', '/api/reservations', '/api/timeclock']) {
      expect(roleMayAccess('cashier', p, GET)).toBe(true);
      expect(roleMayAccess('cashier', p, POST)).toBe(true);
    }
  });

  // Load-bearing: Time Clock lists who is on shift.
  it('may read staff for Time Clock but never change them', () => {
    expect(roleMayAccess('cashier', '/api/staff', GET)).toBe(true);
    expect(roleMayAccess('cashier', '/api/staff', PUT)).toBe(false);
    expect(roleMayAccess('cashier', '/api/staff', DELETE)).toBe(false);
  });

  it('may read expenses for Reports but not write them', () => {
    expect(roleMayAccess('cashier', '/api/expenses', GET)).toBe(true);
    expect(roleMayAccess('cashier', '/api/expenses', POST)).toBe(false);
  });

  it('is refused stock and kitchen data', () => {
    expect(roleMayAccess('cashier', '/api/inventory', GET)).toBe(false);
    expect(roleMayAccess('cashier', '/api/waste', GET)).toBe(false);
  });
});

describe('delivery staff', () => {
  it('reaches deliveries', () => {
    expect(roleMayAccess('delivery-staff', '/api/delivery', GET)).toBe(true);
    expect(roleMayAccess('delivery-staff', '/api/delivery', PUT)).toBe(true);
  });

  // A delivery job is a pointer at an order. Without the order the driver has
  // no items, no total and no way to know whether it is already paid, which is
  // why the Delivery screen showed an address and nothing else.
  it('reads the order behind the job', () => {
    expect(roleMayAccess('delivery-staff', '/api/orders', GET)).toBe(true);
  });

  // Money taken on the doorstep has to be recordable where it is taken;
  // otherwise it is written on a hand and typed in later, which is how a round
  // reconciles short.
  it('records payments and tips it collects', () => {
    expect(roleMayAccess('delivery-staff', '/api/payments', POST)).toBe(true);
    expect(roleMayAccess('delivery-staff', '/api/tips', POST)).toBe(true);
  });

  it('is still refused everything to do with the business', () => {
    for (const p of ['/api/tables', '/api/staff', '/api/expenses', '/api/inventory', '/api/audit']) {
      expect(roleMayAccess('delivery-staff', p, GET)).toBe(false);
    }
  });

  // Recording is not verifying. The driver reports what they took; the till
  // checks it. That separation is enforced in the handler, not here, but the
  // driver must not be able to change the order itself either.
  it('cannot rewrite the order', () => {
    expect(roleMayAccess('delivery-staff', '/api/orders', PUT)).toBe(false);
  });
});

/**
 * The manager provisions every credential; staff do not alter them. A
 * deliberate trade — no self-service rotation, and the manager knows every
 * password, in exchange for one person being accountable for who can reach the
 * till.
 */
describe('password policy', () => {
  it('lets nobody but a manager create or edit an account', () => {
    for (const role of ['cashier', 'head-waiter', 'head-chef', 'delivery-staff', 'cleaner', 'accountant']) {
      expect(roleMayAccess(role, '/api/staff', POST)).toBe(false);
      expect(roleMayAccess(role, '/api/staff', PUT)).toBe(false);
    }
  });

  it('lets nobody but a manager set a password', () => {
    // Both routes are in MANAGER_ONLY, which is checked before the role matrix,
    // so this asserts the matrix does not quietly grant `auth` to anybody.
    for (const role of ['cashier', 'head-waiter', 'head-chef', 'delivery-staff', 'cleaner', 'accountant']) {
      expect(roleMayAccess(role, '/api/auth/reset-password', POST)).toBe(false);
      expect(roleMayAccess(role, '/api/auth/change-password', POST)).toBe(false);
    }
  });

  /**
   * Signing out and asking who you are must never depend on what you may
   * reach, or a role with a narrow matrix could not end its own session.
   */
  it('still lets anyone sign out and check who they are', () => {
    for (const role of ['cashier', 'cleaner', 'delivery-staff']) {
      expect(roleMayAccess(role, '/api/auth/logout', POST)).toBe(false);
    }
    // Those two are handled by isSessionRoute ahead of the matrix, not by it.
    expect(isSessionRoute('/api/auth/logout')).toBe(true);
    expect(isSessionRoute('/api/auth/me')).toBe(true);
  });

  /**
   * The trap this policy creates. must_change_password refuses an account every
   * route except change-password; making that manager-only leaves such an
   * account with nothing it can do. cfg-004 clears the flag, and staff.js and
   * session.js no longer set it — this asserts the route is genuinely no longer
   * a session route, which is what made the old arrangement safe.
   */
  it('no longer treats change-password as a universally reachable route', () => {
    expect(isSessionRoute('/api/auth/change-password')).toBe(false);
  });
});

describe('payment evidence', () => {
  it('lets the till and the driver attach a screenshot', () => {
    expect(roleMayAccess('cashier', '/api/upload', POST)).toBe(true);
    expect(roleMayAccess('delivery-staff', '/api/upload', POST)).toBe(true);
  });

  it('does not hand the upload endpoint to everyone', () => {
    for (const role of ['cleaner', 'assistant-chef', 'head-waiter']) {
      expect(roleMayAccess(role, '/api/upload', POST)).toBe(false);
    }
  });

  /**
   * A transfer screenshot shows an account number, a name and an amount. It
   * lives in the same R2 bucket as menu photos, and /api/images/ is public so
   * the website can render those — so without this it would inherit that.
   *
   * Keys are unguessable, but "hard to guess" is not an access control: the key
   * travels in payloads, logs and screenshots of the till.
   */
  it('treats a payment image as the payment record it belongs to', () => {
    expect(resourceForPath('/api/images/payments/1234-abcd-slip.jpg')).toBe('payments');
    expect(roleMayAccess('cashier', '/api/images/payments/x.jpg', GET)).toBe(true);
    expect(roleMayAccess('cleaner', '/api/images/payments/x.jpg', GET)).toBe(false);
  });

  it('leaves menu and gallery images public', () => {
    expect(isPrivateImage('/api/images/menu/macchiato.jpg')).toBe(false);
    expect(isPrivateImage('/api/images/uploads/hero.png')).toBe(false);
  });

  it('recognises a private key even when it is percent-encoded', () => {
    expect(isPrivateImage('/api/images/payments%2Fslip.jpg')).toBe(true);
  });

  it('refuses to call a key public when it cannot be decoded', () => {
    // A malformed escape cannot be shown to be safe, so it is not treated as such.
    expect(isPrivateImage('/api/images/%E0%A4%A')).toBe(true);
  });
});

describe('the accountant', () => {
  it('reads the whole financial picture', () => {
    for (const p of ['/api/reports/financial', '/api/payments', '/api/purchases', '/api/payroll', '/api/tips']) {
      expect(roleMayAccess('accountant', p, GET)).toBe(true);
    }
  });

  /**
   * An accountant who can edit the sales, payments or payroll they are
   * reconciling is not reconciling anything. Recording a bill that arrived is
   * bookkeeping and is the one exception.
   */
  it('changes almost nothing', () => {
    expect(roleMayAccess('accountant', '/api/expenses', POST)).toBe(true);
    for (const p of ['/api/orders', '/api/payments', '/api/payroll', '/api/purchases', '/api/staff']) {
      expect(roleMayAccess('accountant', p, POST)).toBe(false);
    }
  });

  // The tax bands are theirs to advise on; a manager applies them, so the
  // decision and its audit entry stay with the person answerable for it.
  it('cannot change the tax bands it advises on', () => {
    expect(roleMayAccess('accountant', '/api/settings', PUT)).toBe(false);
  });

  it('has no reach into service operations', () => {
    expect(roleMayAccess('accountant', '/api/tables', PUT)).toBe(false);
    expect(roleMayAccess('accountant', '/api/menu', POST)).toBe(false);
  });
});

describe('HR and payroll', () => {
  it('keeps colleague attendance and pay away from the floor', () => {
    // The matrix is resource-level, not row-level: granting a waiter `leave`
    // would show them everybody's, not just their own.
    for (const role of ['head-waiter', 'cashier', 'head-chef', 'delivery-staff', 'cleaner']) {
      expect(roleMayAccess(role, '/api/payroll', GET)).toBe(false);
      expect(roleMayAccess(role, '/api/leave', GET)).toBe(false);
      expect(roleMayAccess(role, '/api/adjustments', GET)).toBe(false);
    }
  });

  it('lets the manager and the accountant see it', () => {
    for (const role of ['manager', 'accountant']) {
      expect(roleMayAccess(role, '/api/attendance', GET)).toBe(true);
      expect(roleMayAccess(role, '/api/overtime', GET)).toBe(true);
    }
  });

  // Every role needs the service charge and VAT to render a bill; none but the
  // manager may change them.
  it('lets any signed-in staff read settings but not write them', () => {
    for (const role of ['cashier', 'head-waiter', 'head-chef', 'cleaner']) {
      expect(roleMayAccess(role, '/api/settings', GET)).toBe(true);
      expect(roleMayAccess(role, '/api/settings', PUT)).toBe(false);
    }
  });
});

describe('reports reach the screens that fetch them', () => {
  // A Reports or Revenue nav item that opens onto a 403 reads as a broken app.
  it('is readable by every role with a reporting screen', () => {
    for (const role of ['manager', 'accountant', 'cashier', 'head-chef', 'head-waiter']) {
      expect(roleMayAccess(role, '/api/reports/dashboard', GET)).toBe(true);
    }
  });

  it('is still refused to roles without one', () => {
    expect(roleMayAccess('cleaner', '/api/reports/dashboard', GET)).toBe(false);
    expect(roleMayAccess('delivery-staff', '/api/reports/financial', GET)).toBe(false);
  });
});

describe('payments, tips and the audit log', () => {
  it('lets the cashier take and verify money', () => {
    expect(roleMayAccess('cashier', '/api/payments', GET)).toBe(true);
    expect(roleMayAccess('cashier', '/api/payments', POST)).toBe(true);
  });

  // A waiter sees whether the table has settled but cannot mark it settled.
  it('lets a waiter read payments and record a tip, but not take payment', () => {
    expect(roleMayAccess('head-waiter', '/api/payments', GET)).toBe(true);
    expect(roleMayAccess('head-waiter', '/api/payments', POST)).toBe(false);
    expect(roleMayAccess('head-waiter', '/api/tips', POST)).toBe(true);
  });

  it('keeps money away from the kitchen and the cleaner', () => {
    for (const role of ['head-chef', 'assistant-chef', 'cleaner']) {
      expect(roleMayAccess(role, '/api/payments', GET)).toBe(false);
      expect(roleMayAccess(role, '/api/tips', GET)).toBe(false);
    }
  });

  // The audit log names everyone. It appears in no role's list, so the default
  // refusal is what protects it — this asserts that default has not drifted.
  it('is manager-only', () => {
    expect(roleMayAccess('manager', '/api/audit', GET)).toBe(true);
    for (const role of ['cashier', 'head-waiter', 'head-chef', 'delivery-staff', 'cleaner']) {
      expect(roleMayAccess(role, '/api/audit', GET)).toBe(false);
    }
  });
});

describe('cleaner', () => {
  it('reaches waste, and reads tables because their Dashboard counts them', () => {
    expect(roleMayAccess('cleaner', '/api/waste', GET)).toBe(true);
    expect(roleMayAccess('cleaner', '/api/waste', POST)).toBe(true);
    expect(roleMayAccess('cleaner', '/api/tables', GET)).toBe(true);
  });

  it('may not change tables, only see them', () => {
    expect(roleMayAccess('cleaner', '/api/tables', PUT)).toBe(false);
  });

  it('is refused orders and everything financial', () => {
    for (const p of ['/api/orders', '/api/expenses', '/api/cashdrawer', '/api/staff']) {
      expect(roleMayAccess('cleaner', p, GET)).toBe(false);
    }
  });
});

describe('defaults', () => {
  it('refuses an unknown or missing role rather than letting it through', () => {
    for (const r of ['', null, undefined, 'intern', 'admin']) {
      expect(roleMayAccess(r, '/api/orders', GET)).toBe(false);
    }
  });

  it('refuses a resource nobody was granted', () => {
    // Nothing maps 'payroll'; an unlisted resource must not fall through.
    expect(roleMayAccess('head-chef', '/api/payroll', GET)).toBe(false);
    expect(roleMayAccess('cashier', '/api/payroll', GET)).toBe(false);
  });

  it('lets every POS role read the shared catalogue', () => {
    for (const r of ROLES) {
      expect(roleMayAccess(r, '/api/menu', GET)).toBe(true);
      expect(roleMayAccess(r, '/api/content', GET)).toBe(true);
    }
  });

  it('lets only the manager change the shared catalogue', () => {
    for (const r of ROLES.filter((x) => x !== 'manager')) {
      expect(roleMayAccess(r, '/api/menus/save', POST)).toBe(false);
      expect(roleMayAccess(r, '/api/content/publish', POST)).toBe(false);
      expect(roleMayAccess(r, '/api/gallery/save', POST)).toBe(false);
    }
  });

  /**
   * Uploads were manager-only, which was right while the only uploads were menu
   * and gallery images. Payment evidence changed that: §9 requires a screenshot
   * against a Telebirr, CBE or bank payment, and it is taken by whoever takes
   * the money — the cashier at the till, the driver on the doorstep.
   *
   * Recording is still not verifying. Only a cashier or manager can verify a
   * payment, so the driver's evidence is still checked by the till.
   */
  it('allows uploads only to the manager and to whoever takes payment', () => {
    const canUpload = ['manager', 'cashier', 'delivery-staff'];
    for (const r of ROLES) {
      expect(roleMayAccess(r, '/api/upload', POST)).toBe(canUpload.includes(r));
    }
  });
});

// Guards the shape of the matrix itself: every role must be able to do the one
// thing its job is, so a careless edit that empties a list fails here.
describe('every role can still do its own job', () => {
  const CORE = {
    manager: ['/api/staff', GET],
    'head-chef': ['/api/orders', PUT],
    'assistant-chef': ['/api/orders', PUT],
    barista: ['/api/orders', PUT],
    'head-waiter': ['/api/orders', POST],
    cashier: ['/api/cashdrawer', POST],
    'delivery-staff': ['/api/delivery', PUT],
    cleaner: ['/api/waste', POST],
  };

  for (const role of ROLES) {
    it(`${role} can perform its core action`, () => {
      const [path, method] = CORE[role];
      expect(roleMayAccess(role, path, method)).toBe(true);
    });
  }
});
