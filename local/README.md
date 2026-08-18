# The local server

Stage 2 of [LOCAL-SERVER-DESIGN.md](../LOCAL-SERVER-DESIGN.md): the same API,
running on a box in the cafe instead of on Cloudflare.

```
npm run local            # http://0.0.0.0:8787
FUFUT_DATA_DIR=/data PORT=8787 npm run local
```

## What this is

A **host** for the existing Worker, not a second implementation of it.
`server.js` turns a Node request into a `Request`, hands it to the very same
`fetch(request, env, ctx)` that Cloudflare calls, and writes the `Response`
back. Routing, auth, handlers and SQL are untouched — `src/` has no idea it is
running here, and that is the property worth protecting. Two implementations of
a till would drift, and the drift would be discovered during service.

What the Worker asks of its environment is small enough to supply:

| Binding | Locally |
|---|---|
| `env.DB` | `d1.js` — SQLite via `node:sqlite` |
| six `*_KV` namespaces | `kv.js` — a table in the same SQLite file |
| `env.IMAGES_R2` | `r2.js` — a directory on disk |
| cron `* * * * *` | a one-minute interval calling `worker.scheduled` |

## No native dependencies

`node:sqlite` is built into Node, so there is nothing to compile. That is not a
tidiness point: it means the Docker image needs no build toolchain, and the box
in the cafe never has to build a native module over the connection whose absence
is the reason the box exists.

**Requires Node 24.** It exists from 22.5 but needs `--experimental-sqlite`
there; 24 is what this is tested on, and what CI now runs.

## The rule the adapter follows

**Never be more permissive than D1.** A local server that accepts what
production rejects is worse than no local server, because the bug reaches
Cloudflare instead of the test run. Every deliberate divergence in `d1.js` runs
that way:

- **Booleans are coerced**, because D1 accepts them and the driver refuses them.
  Without this, a handler binding `true` would work in production and fail in
  the cafe.
- **`undefined` still throws**, because D1 throws. It nearly always means a
  misspelled property, and quietly binding NULL turns a crash into a wrong row.
- **Rows are converted to ordinary objects.** The driver returns null-prototype
  ones, which stringify fine and then die the first time anything calls a method
  on them.
- **`batch()` is a real transaction**, because D1's is. `orders.js` puts an
  order and its lines in as one batch, and a half-applied batch is a ticket on
  the kitchen board missing items nobody knows were ordered.
- **`foreign_keys` is ON.** SQLite defaults it off; D1 enforces constraints.

`journal_mode = WAL` and `busy_timeout` are for the service floor rather than
for parity: the kitchen display reads while a waiter writes, and a concurrent
writer should wait its turn instead of throwing SQLITE_BUSY at a member of staff.

## The schema

`schema.sql` is dumped from the production database, not replayed from the
migration history. Replaying 13 migrations to reach a state we can read directly
off the live database is a chance to arrive somewhere subtly different, and
behaving identically is the entire value of the box. Regenerate with
`npm run local:schema` after a migration.

A fresh `FUFUT_DATA_DIR` gets the schema applied automatically, and nothing else
— no staff, no menu, no tables. Seeding a real venue is stage 3.

## Tests

- `test/local-d1.test.js` — the adapter, tested only where it *can* diverge
  from D1. A "does SELECT work" test would prove nothing.
- `test/local-runtime.test.js` — the whole Worker end to end. Every other test
  in this suite mocks `env.DB`, so this is the only one that can tell you the
  real handlers survive contact with real SQLite: sign-in, session, an order
  with batched lines, the atomic table claim returning 409 to the second
  waiter, KV, image serving, and the scheduled sweep.

Verified by hand too: over HTTP, and across a restart on the same data
directory — session, order and table state all survive, which is what a power
cut looks like.

## Not yet true

This is a runtime, not a deployment. Still outstanding from the design doc:

- **No sync.** Nothing moves between this box and Cloudflare in either
  direction. Run it against production data and you have a fork, not a mirror.
- **No packaging.** Docker, the bind mount, `restart: unless-stopped` and the
  nightly copy off the box are stage 3.
- **API only.** The POS and backoffice bundles are still served from
  Cloudflare Pages; tablets would reach the app over the internet and only the
  API locally. Serving the built apps from this box is part of stage 3.

## One warning

The server binds all interfaces on purpose — the tablets reach it across the
cafe WiFi, so localhost-only would defeat the point. It must **never** be
exposed to the internet by a router's port forwarding. The cloud Worker is the
front door; this is not it.
