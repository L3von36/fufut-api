-- CFG 005 — normalise stored roles, and correct Bethel Assefa to cashier.
--
-- ── The drift ──────────────────────────────────────────────────────────────
--
-- Roles were stored in whatever case the client sent: "Cashier", "Head Chef",
-- "Manager" in title case, and one lone lowercase "cleaner". Access still
-- worked, because roleMayAccess() lowercases and hyphenates before looking up.
--
-- What it broke was the backoffice. Its role dropdown offers canonical values
-- (`cashier`, `head-chef`), so a <select> bound to "Cashier" matched no option
-- and rendered blank for every existing member of staff — which looks exactly
-- like a missing change-role feature, and is why one was asked for.
--
-- It is also the likely origin of the odd lowercase row: pick a value from that
-- dropdown and it saves canonical, so whoever last edited that account changed
-- both its case and, apparently, its role.
--
-- ── Bethel Assefa ──────────────────────────────────────────────────────────
--
-- Stored as `cleaner`; the session handover records her as a Cashier, and the
-- business confirms cashier. As `cleaner` she reaches Waste and the Dashboard
-- and nothing else — no cash drawer, no orders, no tables — so if she has been
-- working the till she has not been able to use the system for it.
--
-- Corrected here. handlers/staff.js now normalises and validates the role on
-- every write, so neither the drift nor an invented role can recur.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/cfg-005-normalise-roles.sql

-- Canonical form: lowercase, hyphenated — the key both permission matrices use.
UPDATE staff SET role = 'manager'         WHERE LOWER(REPLACE(role, ' ', '-')) = 'manager';
UPDATE staff SET role = 'head-chef'       WHERE LOWER(REPLACE(role, ' ', '-')) = 'head-chef';
UPDATE staff SET role = 'assistant-chef'  WHERE LOWER(REPLACE(role, ' ', '-')) = 'assistant-chef';
UPDATE staff SET role = 'head-waiter'     WHERE LOWER(REPLACE(role, ' ', '-')) = 'head-waiter';
UPDATE staff SET role = 'cashier'         WHERE LOWER(REPLACE(role, ' ', '-')) = 'cashier';
UPDATE staff SET role = 'delivery-staff'  WHERE LOWER(REPLACE(role, ' ', '-')) = 'delivery-staff';
UPDATE staff SET role = 'cleaner'         WHERE LOWER(REPLACE(role, ' ', '-')) = 'cleaner';
UPDATE staff SET role = 'accountant'      WHERE LOWER(REPLACE(role, ' ', '-')) = 'accountant';

-- Bethel to cashier. Done after the normalisation so it is not undone by it.
UPDATE staff SET role = 'cashier' WHERE email = 'bethel@fufut.coffee';

INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-cfg005-roles', datetime('now'), NULL, 'system (cfg 005)', 'system', 'update',
   'staff', NULL, '{"role":"mixed case"}', '{"role":"canonical lowercase-hyphen"}',
   'Roles normalised. Stored values had drifted to title case, which the permission matrices tolerate but the backoffice dropdown does not — it rendered blank for every member of staff, which is why a change-role feature appeared to be missing.'),
  ('AL-cfg005-bethel', datetime('now'), NULL, 'system (cfg 005)', 'system', 'update',
   'staff', NULL, '{"role":"cleaner"}', '{"role":"cashier"}',
   'Bethel Assefa corrected to cashier. As cleaner she could reach only Waste and the Dashboard — no cash drawer, orders or tables.');
