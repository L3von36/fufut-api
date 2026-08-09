import { describe, it, expect } from 'vitest';
import { roleMayAccess, resourceForPath } from '../src/auth.js';

const GET = 'GET';
const POST = 'POST';
const PUT = 'PUT';
const DELETE = 'DELETE';

const ROLES = [
  'manager',
  'head-chef',
  'assistant-chef',
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

describe('assistant chef', () => {
  it('is narrower than the head chef', () => {
    expect(roleMayAccess('assistant-chef', '/api/orders', GET)).toBe(true);
    expect(roleMayAccess('assistant-chef', '/api/inventory', GET)).toBe(true);
    // No Reports screen, so no reason to read expenses.
    expect(roleMayAccess('assistant-chef', '/api/expenses', GET)).toBe(false);
    expect(roleMayAccess('assistant-chef', '/api/waste', GET)).toBe(false);
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
  it('reaches only deliveries', () => {
    expect(roleMayAccess('delivery-staff', '/api/delivery', GET)).toBe(true);
    expect(roleMayAccess('delivery-staff', '/api/delivery', PUT)).toBe(true);
    for (const p of ['/api/orders', '/api/tables', '/api/staff', '/api/expenses']) {
      expect(roleMayAccess('delivery-staff', p, GET)).toBe(false);
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

  it('refuses uploads to everyone but the manager', () => {
    for (const r of ROLES.filter((x) => x !== 'manager')) {
      expect(roleMayAccess(r, '/api/upload', POST)).toBe(false);
    }
    expect(roleMayAccess('manager', '/api/upload', POST)).toBe(true);
  });
});

// Guards the shape of the matrix itself: every role must be able to do the one
// thing its job is, so a careless edit that empties a list fails here.
describe('every role can still do its own job', () => {
  const CORE = {
    manager: ['/api/staff', GET],
    'head-chef': ['/api/orders', PUT],
    'assistant-chef': ['/api/orders', PUT],
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
