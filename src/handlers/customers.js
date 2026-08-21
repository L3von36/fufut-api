import { d1Query, d1Run, json, readBody } from '../lib/db.js';
import { writeAudit } from '../lib/audit.js';

export async function handleCustomers(pathname, method, url, request, env, auth) {
  if (!pathname.startsWith('/api/customers')) return null;

  const m = method.toUpperCase();
  const sub = pathname.replace(/^\/api\/customers/, '');

  // GET /api/customers — search or list
  if (m === 'GET' && (sub === '' || sub === '/')) {
    const q = url.searchParams.get('q') || '';
    const phone = url.searchParams.get('phone') || '';
    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];
    if (phone) {
      sql += ' AND phone = ?';
      params.push(phone);
    } else if (q) {
      sql += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY visits_count DESC LIMIT 50';
    const { results } = await d1Query(env, sql, params).catch(() => ({ results: [] }));
    return json({ ok: true, customers: results || [] });
  }

  // POST /api/customers — create new customer
  if (m === 'POST' && (sub === '' || sub === '/')) {
    const data = await readBody(request);
    if (!data || !data.name) return json({ ok: false, error: 'Customer name is required' }, 400);

    const nowIso = new Date().toISOString();
    const id = `CUST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const phone = data.phone ? String(data.phone).trim() : null;

    try {
      await d1Run(env, `
        INSERT INTO customers (id, name, phone, email, points, total_spent, visits_count, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, data.name.trim(), phone, data.email || null, 0, 0, 0, data.notes || null, nowIso, nowIso]);

      await writeAudit(env, auth, { action: 'create', entity: 'customers', entityId: id, after: { name: data.name, phone } });
      return json({ ok: true, id, name: data.name, phone, points: 0 });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return json({ ok: false, error: 'A customer with that phone number already exists' }, 409);
      }
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /api/customers/:id
  if (m === 'GET' && /^\/[^/]+$/.test(sub)) {
    const id = sub.slice(1);
    const { results } = await d1Query(env, 'SELECT * FROM customers WHERE id = ? OR phone = ?', [id, id]);
    const cust = results && results[0];
    if (!cust) return json({ ok: false, error: 'Customer not found' }, 404);

    const { results: txns } = await d1Query(env, 'SELECT * FROM loyalty_transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20', [cust.id]).catch(() => ({ results: [] }));
    return json({ ok: true, customer: cust, transactions: txns || [] });
  }

  // PATCH /api/customers/:id/points — adjust points (earn or redeem)
  if (m === 'POST' && /^\/[^/]+\/points$/.test(sub)) {
    const id = sub.split('/')[1];
    const data = await readBody(request);
    if (!data || data.points === undefined) return json({ ok: false, error: 'Points delta required' }, 400);

    const { results } = await d1Query(env, 'SELECT * FROM customers WHERE id = ?', [id]);
    const cust = results && results[0];
    if (!cust) return json({ ok: false, error: 'Customer not found' }, 404);

    const delta = parseInt(data.points, 10);
    const newBalance = Math.max(0, (cust.points || 0) + delta);
    const nowIso = new Date().toISOString();

    await d1Run(env, 'UPDATE customers SET points = ?, updated_at = ? WHERE id = ?', [newBalance, nowIso, id]);
    const txnId = `LTX-${Date.now().toString(36)}`;
    await d1Run(env, `
      INSERT INTO loyalty_transactions (id, customer_id, order_id, points, type, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [txnId, id, data.orderId || null, delta, data.type || (delta >= 0 ? 'earn' : 'redeem'), data.description || '', nowIso]);

    return json({ ok: true, customerId: id, newBalance });
  }

  return null;
}
