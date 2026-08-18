# The local server

Stages 2–3 of [LOCAL-SERVER-DESIGN.md](../LOCAL-SERVER-DESIGN.md): the same API,
running on a box in the cafe instead of on Cloudflare — packaged in Docker,
serving the built apps, and backing itself up nightly.

```
npm run local            # http://0.0.0.0:8787
FUFUT_DATA_DIR=/data PORT=8787 npm run local
```

For the box itself, prefer Docker — see below, and
[RUNBOOK.md](RUNBOOK.md) for the day-to-day.

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
— no staff, no menu, no tables. For a rehearsal you want the real venue, so
`seed-from-cloud.js` fills a local database from the live one:

```
node local/seed-from-cloud.js             # refuses if data is already there
node local/seed-from-cloud.js --force     # replaces the local database
node local/seed-from-cloud.js --schema-only
```

## The box (stage 3)

```
docker compose up -d      # build, start, and keep it started
docker compose ps         # is it healthy
```

Why an image rather than `git pull` + `npm ci`: an image is atomic. A pull over
a bad connection can fail halfway and leave a broken server in a building with
nobody technical in it. The image either pulls or it does not, and the running
container is untouched until it does. There is no build stage and no `npm ci`
in it — the Worker imports nothing outside `node:*`, so the image is Node plus
this repository's source, with no runtime supply chain at all.

`data/`, `web/` and `backups/` are **host bind mounts, not named volumes**: one
`docker compose down -v` on a named volume and the trading history is gone.
A bind mount is a directory somebody can see, copy and back up without knowing
anything about Docker.

- **`/_local/health`** is the container healthcheck. It reads from SQLite
  rather than just answering 200, because a process that is up but cannot reach
  its database is exactly the state a restart fixes and a liveness-only check
  hides. It is deliberately *not* `/api/health`, which requires a session —
  correctly — and would mean poking a hole in the auth matrix for Docker.
- **`web/`** holds the built apps, and `server.js` serves them on the same
  origin as the API. This works with the production bundles and no rebuild,
  because the POS already defaults to same-origin
  (`VITE_API_URL || ''`): the session cookie stays first-party, no CORS.
  Layout: the POS built with `--base=/` at the root, the backoffice with
  `--base=/backoffice/` in a subdirectory. Client-side routes get the nearest
  app's shell (the shell-walk), `/api/*` always wins over any stray file, and
  a missing asset is a miss — never index.html dressed up as JavaScript.
- **`backup.js`** takes a consistent snapshot with `VACUUM INTO` — copying
  `fufut.sqlite` with `cp` is wrong in WAL mode — and verifies the result by
  opening it before claiming success. The backup container runs it nightly at
  03:00 Africa/Addis_Ababa. Until the sync engine exists, this is the entire
  disaster plan: lose the box and you lose everything since the last one.
  Restoring is in the [runbook](RUNBOOK.md).

## Tests

- `test/local-d1.test.js` — the adapter, tested only where it *can* diverge
  from D1. A "does SELECT work" test would prove nothing.
- `test/local-runtime.test.js` — the whole Worker end to end. Every other test
  in this suite mocks `env.DB`, so this is the only one that can tell you the
  real handlers survive contact with real SQLite: sign-in, session, an order
  with batched lines, the atomic table claim returning 409 to the second
  waiter, KV, image serving, and the scheduled sweep.
- `test/local-http.test.js` — the HTTP layer around the Worker, against a real
  child process: `/_local/health` in both its states (database answering, and
  database present but blind → 503), the static server's routing (shells,
  immutable assets, `/api/*` precedence, traversal contained), and the SSE
  stream's connected event.

Verified by hand too: over HTTP, and across a restart on the same data
directory — session, order and table state all survive, which is what a power
cut looks like. The Docker path was verified end to end on the development
machine: image builds, `docker compose up` goes healthy, the box serves the
built apps and answers the API on the same origin, and a backup taken inside
the container lands on the host verified.

## Not yet true

This is a deployment, not a sync target. Still outstanding from the design doc:

- **No sync.** Nothing moves between this box and Cloudflare in either
  direction. Run it against production data and you have a fork, not a mirror.
  The nightly backup is a snapshot, not a reconciliation.
- **Untested on the actual box.** Everything Docker-side is verified on the
  development machine; stage 3 ends on hardware in the cafe.

## One warning

The server binds all interfaces on purpose — the tablets reach it across the
cafe WiFi, so localhost-only would defeat the point. It must **never** be
exposed to the internet by a router's port forwarding. The cloud Worker is the
front door; this is not it.
