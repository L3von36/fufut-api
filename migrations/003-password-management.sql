-- 003 — password management.
--
-- Until now there was no way to set or change a password anywhere in the system.
-- sha256() existed only to verify; nothing ever wrote a hash. Staff rows were
-- seeded directly into D1, which is why every account shares one password, and a
-- staff member created through either UI got no hash at all and was refused at
-- login with "Account has no password set".
--
-- Additive only. Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/003-password-management.sql

-- Forces a password change at next sign-in. Set when a manager resets someone,
-- cleared when that person chooses their own. Without this, "reset" hands out a
-- known temporary password that nobody is ever obliged to replace - which is
-- exactly how one shared password happened in the first place.
ALTER TABLE staff ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- When the password was last set, so a manager can see who is still on a
-- credential they were issued rather than one they chose.
ALTER TABLE staff ADD COLUMN password_set_at TEXT;

-- NOTE: this file only adds the columns, and every account defaults to 0, so
-- applying it changes nobody's experience. Forcing the existing shared password
-- to be replaced is deliberately a separate step - 004 - because it must not run
-- until the POS can actually show a change-password screen. Run in the wrong
-- order it locks every member of staff out of a shift with no way forward.
