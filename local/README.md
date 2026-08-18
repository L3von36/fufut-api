# The local server

Stages 2–5 of [LOCAL-SERVER-DESIGN.md](../LOCAL-SERVER-DESIGN.md): the same API,
running on a box in the cafe instead of on Cloudflare — packaged in Docker,
serving the built apps, backing itself up nightly, and syncing with the cloud.

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

## Sync (stages 4–5)

Off unless `CLOUD_URL` and `SYNC_TOKEN` are both set. Without them the box
journals its writes and talks to nobody, which is exactly stage 3's behaviour.

```
CLOUD_URL=https://fufut-api.fufutcoffee.workers.dev
SYNC_TOKEN=<the same value as the Worker secret>
```

Put those in a `.env` beside `docker-compose.yml`, not in the compose file —
`SYNC_TOKEN` is a shared secret and that file is committed.

### How it works

Every write goes through `d1Run` or `d1Batch` in `src/lib/db.js`, and those two
choke points journal it into `sync_outbox` — the SQL verbatim, with its
parameters. Hooking two functions rather than ~80 handler call sites is what
makes this tractable; recording the statement rather than a reconstructed row is
what keeps it honest, because the handlers build dynamic column lists and SET
clauses that any re-interpretation here would eventually get wrong.

Every 30 seconds the box checks the cloud is reachable, pushes what the cloud
has not acknowledged, pulls what it has not seen, applies it, and prunes
journal entries both sides finished with a week ago.

| Route | Auth | What |
|---|---|---|
| `POST /api/sync/push` | `SYNC_TOKEN` | the box hands over its journal |
| `GET /api/sync/pull` | `SYNC_TOKEN` | the box collects the cloud's |
| `GET /api/sync/status` | `SYNC_TOKEN` | liveness, and the heartbeat |
| `GET /api/sync/reconciliation` | manager session | what the rules refused |
| `GET /api/venue/status` | public | can the website take an order |
| `GET /_local/sync` | none, box only | what this box knows about itself |

### Ownership

`src/lib/ownership.js`, and it lives in `src/` rather than here because **both
sides run it**. Two copies would drift silently and only in the direction that
loses data, since a disagreement means one side takes a write the other refused.

| Entity | Rule |
|---|---|
| `tables`, `timeclock` | local wins — the box watches the actual floor |
| `payments`, `audit_log`, stock movements | append-only; union, never merge |
| `orders`, `order_items` | creator owns; the two sides write different ids |
| `reservations`, `menu*`, `staff`, `settings`, `reviews` | cloud wins |
| anything else | cloud wins |

The rule is symmetric: **an incoming write to an entity the receiver owns is
never applied.** It becomes a conflict and goes to `sync_reconciliation` for a
human. That is a real path, not a theoretical one — a manager using the
backoffice on the box during an outage writes to cloud-owned entities.

### Three things that would each be silent data loss

- **Replay bypasses `d1Run`.** Applying an entry writes through `env.DB`
  directly, so it is invisible to capture. Otherwise each side would journal the
  other's replays, push them back, and the pair would never go quiet again.
- **A replayed `UPDATE` that changes 0 rows is a refusal, not a success.** The
  handlers write conditional updates — the atomic table claim carries
  `AND status <> 'occupied'` — and a condition re-evaluated against the
  receiver's state can quietly match nothing.
- **`venue_heartbeat` is excluded from capture,** like the cursors. It is
  written every 30 seconds; journalling it would have the cloud handing the box
  ~2,880 entries a day saying only that the box is alive.

### What is not built

Multi-venue, real-time sync (polling is enough for one venue), R2 image sync
(images are served from whichever origin holds them), and a reconciliation UI in
the backoffice — the table and the API exist, the screen does not.

**And none of it has run against real Cloudflare.** Every test to date exercises
the cloud side against local SQLite standing in for D1. The difference that
matters is that D1 is remote: a push that times out mid-batch is a real case the
tests cannot produce. Rehearse against a staging Worker before pointing the cafe
at this.

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
- `test/outbox.test.js` — capture, against real SQLite rather than a mock: a
  mocked `env.DB` would only prove that capture calls the mock.
- `test/sync-api.test.js` — the protocol through the real Worker and the real
  authorization gate.
- `test/sync-engine.test.js` — **both sides at once.** Two real databases, one
  standing in for each, with the daemon's `fetch` wired straight into the
  cloud's Worker: a push really is a Request through the real gate into the real
  handler, and only the wire is missing. Every interesting failure here is an
  interaction between the two sides — an echo loop, a rewinding cursor, a rule
  applied in one direction only — and a mocked peer cannot produce one.
- `test/venue-offline.test.js` — the ordering refusal, including that staff are
  never refused and that an unreadable heartbeat opens ordering rather than
  closing it.

Verified by hand too: over HTTP, and across a restart on the same data
directory — session, order and table state all survive, which is what a power
cut looks like. The Docker path was verified end to end on the development
machine: image builds, `docker compose up` goes healthy, the box serves the
built apps and answers the API on the same origin, and a backup taken inside
the container lands on the host verified.

## Not yet true

Everything in the design doc is built. What remains is not code:

- **Nothing is switched on.** Capture is gated on `SITE_ID`, still commented out
  in `wrangler.toml`, and the machine routes do not exist without `SYNC_TOKEN`.
  Production behaves exactly as it did before any of this. See "Turning it on"
  in the design doc for the order to do it in.
- **Never run against real Cloudflare.** The cloud side has only ever been
  exercised against local SQLite pretending to be D1. D1 is remote, and a push
  that times out mid-batch is a case these tests cannot produce.
- **Untested on the actual box.** Everything Docker-side is verified on the
  development machine. The cafe has different hardware, a different network and
  nobody technical in the building.

## One warning

The server binds all interfaces on purpose — the tablets reach it across the
cafe WiFi, so localhost-only would defeat the point. It must **never** be
exposed to the internet by a router's port forwarding. The cloud Worker is the
front door; this is not it.
