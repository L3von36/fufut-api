-- 004 — end the shared password.
--
-- Every account was seeded with the same password and there has never been a way
-- to change it, so all seven share one credential. This requires each of them to
-- choose their own at next sign-in.
--
-- ⚠️ ORDER MATTERS. Do not run this until BOTH are true:
--   1. The API exposing /api/auth/change-password is deployed.
--   2. The POS build that shows the change-password screen is live.
-- Run early, and every member of staff signs in to a 403 on every screen with
-- no way to resolve it, in the middle of a service.
--
-- Nobody is signed out by this. Existing sessions keep working, but the
-- authorize() gate refuses everything except changing the password, so the next
-- action each person takes sends them to that screen.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/004-force-password-change.sql

UPDATE staff SET must_change_password = 1;
