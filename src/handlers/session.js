import { verifyPassword } from '../lib/crypto.js';
import { d1Query, d1Run, json, now, readBody } from '../lib/db.js';

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
  var token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3).toISOString();
  await d1Run(env, "INSERT INTO sessions (token, staff_id, role, expires_at) VALUES (?,?,?,?)", [token, staff.id, staff.role, expiresAt]);
  var user = stripPwd(staff);
  return new Response(JSON.stringify({ ok: true, user, role: staff.role }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": makeSessionCookie(token) }
  });
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
  return json({ ok: true, user, role: session.staffRole });
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
  var r = await d1Query(env, "SELECT s.staff_id, s.role as sessionRole, st.status FROM sessions s JOIN staff st ON s.staff_id = st.id WHERE s.token = ? AND s.expires_at > datetime('now')", [token]);
  if (!r.results.length || r.results[0].status !== "active") return null;
  return r.results[0];
}
export { getSessionToken, makeSessionCookie, clearSessionCookie, stripPwd, handleStaffLogin, handleSessionCheck, handleLogout, getAuthUser };
