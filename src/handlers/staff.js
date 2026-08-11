import { d1Query, d1Run, json, now, readBody } from '../lib/db.js';
import { hashPassword, generateTempPassword, passwordProblem } from '../lib/crypto.js';

/**
 * Staff accounts.
 *
 * Creating and editing staff is intercepted here rather than left to the generic
 * resource handler, for two reasons.
 *
 * First, that handler writes any column the client names, so a request carrying
 * `password_hash` would be stored verbatim - letting the caller choose the hash
 * for an account, which is the same as choosing its password. `password_hash` is
 * never accepted from a client on any route.
 *
 * Second, an account created without a hash cannot sign in at all: login refuses
 * it with "Account has no password set". Staff were being created that way and
 * silently could not work. Creation now always produces a usable credential.
 *
 * GET and DELETE fall through to the generic handler unchanged.
 */

/** Columns a client may set. Deliberately excludes password_hash and the flags. */
const WRITABLE = ['firstName', 'lastName', 'email', 'phone', 'role', 'status'];

function pick(data) {
  const out = {};
  for (const c of WRITABLE) {
    if (data[c] !== undefined) out[c] = data[c];
  }
  return out;
}

async function handleStaff(pathname, method, request, env) {
  const m = method.toUpperCase();
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'staff') return null;
  const idPart = parts[2] || '';

  if (m === 'POST' && !idPart) {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);
    if (!data.firstName && !data.lastName) {
      return json({ ok: false, error: 'A name is required' }, 400);
    }

    // A caller-supplied password is allowed so a manager can set one directly,
    // but it must clear the same bar the person would have to clear themselves.
    let initial = data.password;
    let generated = false;
    if (initial) {
      const problem = passwordProblem(initial);
      if (problem) return json({ ok: false, error: problem }, 400);
    } else {
      initial = generateTempPassword();
      generated = true;
    }

    const id = data.id || 'S' + crypto.randomUUID().slice(0, 7);
    const fields = pick(data);
    fields.id = id;
    fields.created = now();
    fields.password_hash = await hashPassword(initial);
    // Not set. The flag exists to force the holder to replace a password
    // somebody else chose — but staff can no longer change their own, so
    // setting it would refuse the account every endpoint including the only
    // route it is permitted, leaving it unable to do anything at all.
    //
    // The manager owns the credential for its whole life now, so replacement is
    // a reset, not a self-service change.
    fields.must_change_password = 0;
    fields.password_set_at = new Date().toISOString();

    const cols = Object.keys(fields);
    const placeholders = cols.map(() => '?').join(', ');
    try {
      await d1Run(
        env,
        `INSERT INTO staff (${cols.join(', ')}) VALUES (${placeholders})`,
        cols.map((c) => fields[c])
      );
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }

    return json({
      ok: true,
      id,
      // Returned once, for the manager to hand over in person. Only included
      // when this endpoint invented it; an password the manager chose is
      // already known to them and does not need echoing back.
      temporaryPassword: generated ? initial : undefined,
      mustChangePassword: true,
    });
  }

  if (m === 'PUT') {
    const data = await readBody(request);
    if (!data) return json({ ok: false, error: 'Invalid JSON body' }, 400);
    const itemId = idPart || data.id;
    if (!itemId) return json({ ok: false, error: 'id required' }, 400);

    // Passwords are changed through /api/auth/change-password or reset by a
    // manager through /api/auth/reset-password. Never as a field on the record,
    // so there is exactly one path to a credential and it is audited.
    if (data.password !== undefined || data.password_hash !== undefined) {
      return json(
        { ok: false, error: 'Use /api/auth/reset-password to issue a new password' },
        400
      );
    }

    const fields = pick(data);
    if (!Object.keys(fields).length) return json({ ok: false, error: 'No fields to update' }, 400);

    const setClause = Object.keys(fields).map((c) => `${c} = ?`).join(', ');
    const values = Object.keys(fields).map((c) => fields[c]);
    values.push(String(itemId));

    try {
      const { meta } = await d1Run(env, `UPDATE staff SET ${setClause} WHERE id = ?`, values);
      if (!meta.changes) return json({ ok: false, error: 'Staff not found' }, 404);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  }

  return null; // GET and DELETE keep the generic behaviour
}

export { handleStaff, WRITABLE };
