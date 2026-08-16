# Provenance

This source did not exist before 2026-08-08. It was reconstructed from the
Worker running in production, because no repository for it had ever been kept.

Recording this matters: a future maintainer needs to know how faithful this
source is to what was running, and how to re-verify that claim themselves.

## What it was reconstructed from

Fetched from the Cloudflare API on 2026-08-08:

```
GET /accounts/8793f2ad3a46fcc18960393d39961ba5/workers/scripts/fufut-api
```

| Artifact | SHA-256 |
|---|---|
| Deployed bundle (`index.js` from the multipart upload) | `6eb22975edcf8f6e3aa2e98525653f3b11a556c7b67f9d080cdce1f6e60b93af` |
| Same bundle with esbuild `__name`/`__defProp` noise stripped | `642401316d69986cce56d45d2f0c847bb628ea5c6869bbeb40b2668efddf16f8` |

Both are kept outside this repo at `../fufut-api-src/backup/`, along with
`fufut-api-OLD-hono-with-auth.js` — an earlier Hono build recovered from a
deleted `repos/worker.js` in the `fufut-management` history, which *did* enforce
auth on 13 routes.

## Method, and what that buys you

The bundle was not minified — esbuild had preserved full identifiers. So rather
than reinterpreting 2,800 lines of business logic by hand, every handler body
was lifted **verbatim** and split into modules mechanically. Only the module
boundaries and import statements are new.

This was a deliberate trade. Rewriting from scratch would have produced nicer
code and an unknown number of subtle behavioural differences in a system taking
live restaurant orders. Copying preserves behaviour exactly and makes the
security change the only meaningful diff.

**Verified:** `/api/content`, `/api/menu`, `/api/menus` and `/api/reviews`
returned byte-identical payloads (md5) from the reconstruction and from the
then-live Worker.

## What was intentionally changed

1. `src/auth.js` — new. The deployed Worker defined `getAuthUser()` and never
   called it, so every endpoint answered unauthenticated.
2. `handleStaffLogin` — previously skipped password verification entirely for
   any non-Manager without a `password_hash`; such an account accepted any
   password. No existing staff row was affected.

Everything else is the deployed logic, reorganised.

## Re-verifying this yourself

```bash
node scripts/check-drift.mjs      # deployed vs this repo
node scripts/smoke.mjs <url>      # live auth assertions
```

## Known divergence from the schema

`buildOrderPayload()` in the POS sends `orderItems`, `notes`, `subtotal`, `tip`,
`discount` and `paymentBreakdown`. The `orders` table has none of those columns,
so they are silently dropped — order notes, including allergies, never reach the
kitchen. Not introduced here; documented so it is not mistaken for a
reconstruction error. See `../fufut-management/FIX-PROMPT.md` Task 7.
