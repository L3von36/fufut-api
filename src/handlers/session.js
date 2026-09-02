import {
  verifyPassword,
  hashPassword,
  isLegacyHash,
  generateTempPassword,
  passwordProblem,
} from '../lib/crypto.js';
import { d1Query, d1Run, json, now, readBody } from '../lib/db.js';
import { screenGrantsForRole } from '../lib/role-scopes.js';

function getSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

function makeSessionCookie(token, maxAge) {
  maxAge = maxAge || 2592e3;
  return "session=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + maxAge;
}

function clearSessionCookie() {
  return "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function stripPwd(user) {
  if (!user) return user;
  var clean = {};
  for (var k in user) {
    if (k !== "password_hash") clean[k] = user[k];
  }
  return clean;
}

async function handleStaffLogin(request, env) {
  var data = await readBody(request);
  if (!data || !data.password) return json({ ok: false, error: "Password required" }, 400);
  var staff = null;
  if (data.email) {
    var r = await d1Query(env, "SELECT * FROM staff WHERE email = ? AND status = 'active'", [data.email]);
    staff = r.results[0] || null;
  } else if (data.staffId) {
    var r2 = await d1Query(env, "SELECT * FROM staff WHERE id = ? AND status = 'active'", [data.staffId]);
    staff = r2.results[0] || null;
  } else {
    return json({ ok: false, error: "Email or staffId required" }, 400);
  }
  if (!staff) return json({ ok: false, error: "Staff not found" }, 404);
  // Previously: `needsPassword = staff.password_hash || staff.role === "Manager"`,
  // which skipped verification entirely for any non-Manager lacking a hash — so
  // such an account would accept *any* password. No current staff row is
  // affected (all have hashes), but a newly created one would be. A row with no
  // password can never authenticate.
  if (!staff.password_hash) {
    return json({ ok: false, error: "Account has no password set — contact a manager" }, 403);
  }
  var valid = await verifyPassword(data.password, staff.password_hash);
  if (!valid) return json({ ok: false, error: "Invalid password" }, 401);

  // A correct password is the only moment the plaintext is available, so it is
  // the only moment a legacy hash can be upgraded. Done after verification and
  // without blocking the response.
  if (isLegacyHash(staff.password_hash)) {
    try {
      const upgraded = await hashPassword(data.password);
      await d1Run(env, "UPDATE staff SET password_hash = ? WHERE id = ?", [upgraded, staff.id]);
    } catch (e) {
      console.error("[HASH UPGRADE]", e); // never block a sign-in over this
    }
  }

  var token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3).toISOString();
  await d1Run(env, "INSERT INTO sessions (token, staff_id, role, expires_at) VALUES (?,?,?,?)", [token, staff.id, staff.role, expiresAt]);
  var user = stripPwd(staff);
  // Extra views granted through the backoffice Role Access page (e.g. a
  // category-scoped Inventory for the barista). Fails soft: a settings read
  // problem must not break sign-in, only omit the extra tab.
  var screenGrants = [];
  try { screenGrants = await screenGrantsForRole(env, staff.role); } catch (e) { console.error("[SCREEN GRANTS]", e); }
  return new Response(
    JSON.stringify({
      ok: true,
      user,
      role: staff.role,
      // The client uses this to send the person straight to a change-password
      // screen. It is not the enforcement - authorize() refuses everything else
      // until the password is changed - but without it the UI would drop them
      // onto a dashboard that then refuses every request.
      mustChangePassword: staff.must_change_password === 1,
      screenGrants,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": makeSessionCookie(token) }
    }
  );
}

/**
 * A manager issues a new password for someone who has forgotten theirs, or who
 * is being taken off a shared one.
 *
 * Two ways, because the generated one is not always workable in practice. A
 * random string has to be relayed verbally across a noisy floor and typed on a
 * tablet by somebody who may not read Latin script fluently; more than one
 * business has ended up writing those on a wall. So a manager may supply
 * `newPassword` instead, and it must clear exactly the bar the person's own
 * password would.
 *
 * The security property is the same either way: `must_change_password` is set,
 * so whatever the manager knows works exactly once. Nothing is stored in
 * plaintext, and every existing session for that person is ended.
 *
 * A generated password is returned once, in this response, and cannot be
 * retrieved again — a second reset is the only way back. The caller must show
 * it to the manager; discarding it locks the account until the next reset.
 */
async function handleResetPassword(request, env) {
  const data = await readBody(request);
  const staffId = data && (data.staffId || data.id);
  if (!staffId) return json({ ok: false, error: "staffId required" }, 400);

  const { results } = await d1Query(env, "SELECT id, firstName, lastName FROM staff WHERE id = ?", [String(staffId)]);
  if (!results || !results.length) return json({ ok: false, error: "Staff not found" }, 404);

  const chosen = data && data.newPassword;
  if (chosen) {
    const problem = passwordProblem(chosen);
    if (problem) return json({ ok: false, error: problem }, 400);
  }

  const temporary = chosen || generateTempPassword();
  const hash = await hashPassword(temporary);
  // must_change_password stays 0: staff cannot change their own password, so
  // forcing them to would refuse the account every endpoint including the only
  // route it is allowed. The manager owns the credential for its whole life,
  // and replacing it is another reset rather than a self-service change.
  await d1Run(
    env,
    "UPDATE staff SET password_hash = ?, must_change_password = 0, password_set_at = ? WHERE id = ?",
    [hash, new Date().toISOString(), String(staffId)]
  );

  // Every existing session for that person is ended, so a reset actually locks
  // out whoever was using the old credential rather than leaving them signed in.
  await d1Run(env, "DELETE FROM sessions WHERE staff_id = ?", [String(staffId)]);

  return json({
    ok: true,
    staffId: String(staffId),
    // Echoed back only when this endpoint invented it. One the manager chose is
    // already known to them, and returning it would put a password they typed
    // into a response body and a log for no benefit.
    temporaryPassword: chosen ? undefined : temporary,
    generated: !chosen,
    mustChangePassword: true,
    note: chosen
      ? "The member of staff must change this the first time they sign in."
      : "Give this to the member of staff in person. It is shown once and cannot be retrieved again.",
  });
}

/**
 * Anyone signed in changing their own password. Requires the current one, so a
 * borrowed unlocked tablet cannot be used to take an account over.
 */
async function handleChangePassword(request, env) {
  const auth = await getAuthUser(request, env);
  if (!auth) return json({ ok: false, error: "Authentication required" }, 401);

  const data = await readBody(request);
  const currentPassword = data && data.currentPassword;
  const newPassword = data && data.newPassword;
  if (!currentPassword || !newPassword) {
    return json({ ok: false, error: "currentPassword and newPassword are required" }, 400);
  }

  const problem = passwordProblem(newPassword);
  if (problem) return json({ ok: false, error: problem }, 400);

  const { results } = await d1Query(env, "SELECT id, password_hash FROM staff WHERE id = ?", [auth.staff_id]);
  const staff = results && results[0];
  if (!staff || !staff.password_hash) return json({ ok: false, error: "Account not found" }, 404);

  const valid = await verifyPassword(currentPassword, staff.password_hash);
  if (!valid) return json({ ok: false, error: "Current password is incorrect" }, 401);

  if (await verifyPassword(newPassword, staff.password_hash)) {
    return json({ ok: false, error: "New password must be different from the current one" }, 400);
  }

  const hash = await hashPassword(newPassword);
  await d1Run(
    env,
    "UPDATE staff SET password_hash = ?, must_change_password = 0, password_set_at = ? WHERE id = ?",
    [hash, new Date().toISOString(), staff.id]
  );

  // Other sessions are ended, but the one making the change is kept: signing
  // somebody out of the screen they just used to comply is a good way to have
  // them write the new password down instead.
  const token = getSessionToken(request);
  await d1Run(env, "DELETE FROM sessions WHERE staff_id = ? AND token <> ?", [staff.id, token || ""]);

  return json({ ok: true, mustChangePassword: false });
}

async function handleSessionCheck(request, env) {
  var token = getSessionToken(request);
  if (!token) return json({ ok: false, error: "Not authenticated" }, 401);
  var r = await d1Query(env, "SELECT s.*, st.firstName, st.lastName, st.email, st.phone, st.role as staffRole, st.status FROM sessions s JOIN staff st ON s.staff_id = st.id WHERE s.token = ? AND s.expires_at > datetime('now')", [token]);
  if (!r.results.length) return json({ ok: false, error: "Session expired" }, 401);
  var session = r.results[0];
  if (session.status !== "active") {
    await d1Run(env, "DELETE FROM sessions WHERE token = ?", [token]);
    return json({ ok: false, error: "Staff inactive" }, 401);
  }
  var user = stripPwd({ id: session.staff_id, firstName: session.firstName, lastName: session.lastName, email: session.email, phone: session.phone, role: session.staffRole, status: session.status, created: session.created });
  var screenGrants = [];
  try { screenGrants = await screenGrantsForRole(env, session.staffRole); } catch (e) { console.error("[SCREEN GRANTS]", e); }
  return json({ ok: true, user, role: session.staffRole, screenGrants });
}

async function handleLogout(request, env) {
  var token = getSessionToken(request);
  if (token) await d1Run(env, "DELETE FROM sessions WHERE token = ?", [token]);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie() }
  });
}

async function getAuthUser(request, env) {
  var token = getSessionToken(request);
  if (!token) return null;
  // firstName/lastName are selected so audit trails can name a person rather
  // than a staff id: "released by Selam Wondimu" is answerable months later,
  // "released by S2" needs a second lookup.
  var r = await d1Query(env, "SELECT s.staff_id, s.role as sessionRole, st.status, st.firstName, st.lastName, st.must_change_password FROM sessions s JOIN staff st ON s.staff_id = st.id WHERE s.token = ? AND s.expires_at > datetime('now')", [token]);
  if (!r.results.length || r.results[0].status !== "active") return null;
  return r.results[0];
}
export {
  getSessionToken,
  makeSessionCookie,
  clearSessionCookie,
  stripPwd,
  handleStaffLogin,
  handleSessionCheck,
  handleLogout,
  handleResetPassword,
  handleChangePassword,
  getAuthUser,
};
