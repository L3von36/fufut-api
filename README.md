# fufut-api

Cloudflare Worker serving **both** the FU FUT COFFEE POS
(`pos.fufutcoffee.com`, via a same-origin Pages proxy) and the public website
(`fufutcoffee.com`).

## Where this source came from

There was no source repository for this Worker — only deployed build artifacts.
This tree was reconstructed on 2026-08-08 from the live bundle
(`GET /accounts/:id/workers/scripts/fufut-api`). Every handler body was lifted
**verbatim** and split into modules, so runtime behaviour is unchanged. Verified
by diffing public endpoint responses against production: `/api/content`,
`/api/menu`, `/api/menus` and `/api/reviews` are byte-identical.

The genuinely new code is `src/auth.js` and its two call sites in
`src/index.js`.

Backups of both artifacts are in `../fufut-api-src/backup/`:
- `fufut-api-DEPLOYED-20260808.multipart` — exact production upload, for rollback
- `fufut-api-OLD-hono-with-auth.js` — an older Hono build that *did* enforce auth

## What was wrong

The deployed Worker defined `getAuthUser()` **and never called it**. Every
endpoint answered unauthenticated. Confirmed against production:

| | Before | After |
|---|---|---|
| `GET /api/staff` | 200 — names, emails, **phone numbers** | 401 |
| `GET /api/reservations` | 200 — customer names, **phones**, emails | 401 |
| `GET /api/orders` | 200 — 32 orders, customers, revenue | 401 |
| `PUT /api/staff/:id` | reached handler validation | 401 |
| `DELETE /api/menu/:id` | reached database lookup | 401 |

Writes were open too — a production probe with malformed JSON returned
`400 Invalid JSON body` and `404 item not found` rather than `401`, proving the
request reached the handler with no auth check.

The older Hono build applied `requireAuth()` to 13 routes. **Enforcement was
lost in a rewrite**, and `getAuthUser` survived as dead code. A regression test
now covers this (`test/auth.test.js`).

Also fixed: `handleStaffLogin` skipped password verification entirely for any
non-Manager without a `password_hash` — such an account would accept *any*
password. No current staff row was affected; a newly created one would have been.

## Authorization model

**Public** (no session) — the website depends on every one of these:
- `GET /api/content`, `/api/menu`, `/api/menus`, `/api/reviews`, `/api/images/*`
- `POST /api/reservations`, `/api/orders`, `/api/reviews` — anonymous customers
- `POST /api/auth/login`

**Authenticated** — everything else.

**Manager only** — `POST /api/migrate/*`, and writes to `/api/staff`.

**Redacted** — `GET /api/staff` drops `phone`/`email` for non-managers (Time
Clock and Shifts still need names and roles). `password_hash` is stripped for
everyone.

### Why per-role reads are not enforced yet

Several POS pages read data outside their role's permission list: Cashier's Time
Clock reads `staff`, Head Chef's Reports reads `expenses`, Head Chef's Orders
reads `menu`. Gating reads by the frontend's `ROLE_PERMISSIONS` would break
those working pages. Closing the public hole is the urgent fix; tightening
per-role reads needs the permission model reworked first — see
`../fufut-management/FIX-PROMPT.md` Task 5.

## Development

```bash
npm install
npm test                  # auth policy tests
npm run build             # dry-run bundle, validates imports
npm run deploy:staging    # -> fufut-api-staging.workers.dev
npm run deploy            # -> production
```

Staging shares production's D1/KV/R2 so tests exercise real data. It
deliberately has **no cron trigger**: production already runs
`checkScheduledPublish()` every minute and a second one would double-publish.

## Rollback

```bash
curl -X PUT \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: multipart/form-data; boundary=<boundary from file>" \
  --data-binary @../fufut-api-src/backup/fufut-api-DEPLOYED-20260808.multipart \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/fufut-api"
```

Or roll back to the previous version in the Cloudflare dashboard
(Workers → fufut-api → Deployments).
