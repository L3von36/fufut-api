-- CFG 004 — clear must_change_password before the manager-only rule deploys.
--
-- ⚠ THIS MUST BE APPLIED BEFORE OR WITH THE WORKER THAT MAKES change-password
--   MANAGER-ONLY. Applied after, nine of ten accounts are locked out.
--
-- ── The interaction ────────────────────────────────────────────────────────
--
-- authorize() refuses an account with must_change_password = 1 every route
-- except PASSWORD_CHANGE_ALLOWED — which is change-password, logout and me. The
-- point was that a person handed a manager-issued credential could do exactly
-- one thing: replace it.
--
-- Making change-password manager-only removes that one thing. An ordinary
-- account carrying the flag would then be refused every endpoint in the system,
-- including the only route it is permitted to reach, and could do nothing at
-- all until a manager reset it — which would set the flag again.
--
-- Nine of the ten accounts carry the flag right now, two of them managers.
--
-- ── Why clearing it is correct rather than a workaround ────────────────────
--
-- The flag means "somebody else chose this, replace it yourself". Under the new
-- rule nobody replaces their own password: the manager owns the credential for
-- its whole life. The instruction the flag encodes no longer exists, so the
-- flag is not being suppressed — it has become meaningless.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/cfg-004-manager-owns-passwords.sql

UPDATE staff SET must_change_password = 0 WHERE must_change_password = 1;

INSERT OR IGNORE INTO audit_log
  (id, at, actor_id, actor_name, actor_role, action, entity, entity_id, before, after, reason)
VALUES
  ('AL-cfg004-pwpolicy', datetime('now'), NULL, 'system (cfg 004)', 'system', 'update',
   'staff', NULL, '{"must_change_password":1,"self_service_change":true}',
   '{"must_change_password":0,"self_service_change":false}',
   'Password policy changed at the business''s instruction: only a manager may set or change any password, including their own staff''s. Self-service change removed. must_change_password cleared because it would otherwise refuse those accounts every route including the only one they were allowed, locking out 9 of 10 accounts.');
