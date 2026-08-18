# Running without the internet — local server design

**Status:** all five stages built, and the four decisions made — see "Decisions
made" and "Turning it on". Not live: capture is gated on `SITE_ID`, which is
still commented out in `wrangler.toml`, so production behaves exactly as it did
before any of this.
**Date:** 2026-08-18

## The problem

Ethiopia loses internet. Not briefly and not rarely, and when it goes the whole
country goes, so "wait a few minutes" is not a plan. This document is about what
FU FUT does for the hours or days the line is down.

The system is not helpless today. The POS is a real offline-first PWA: a service
worker caches the app shell, IndexedDB caches reads for twelve resources, failed
writes queue into a `sync_queue` store, and `useSync` replays them on reconnect.
A tablet already signed in keeps taking orders through an outage and loses
nothing.

Two things break anyway, and they are the two that matter.

**Every device becomes an island.** Queued writes sit on the device that made
them. A waiter's order never reaches the chef's board, because that handoff goes
through the server. Each screen looks healthy while the coordination the POS
exists to provide has stopped. This is not a bug to fix in the client — it is
what "the server is unreachable" means.

**Nobody can sign in.** Auth is deliberately excluded from the offline queue
(auth mutations rethrow instead of queueing), correctly, since a password cannot
be checked without the server. But any tablet that reboots, and any member of
staff starting a shift mid-outage, is locked out. The router guard calls
`/api/auth/me` on load, so a reload during an outage lands on a login screen
that cannot be passed.

## What comparable systems do

**Toast** is cloud-first with a local fallback. Offline mode auto-activates
after 40 seconds. Critically they elect a *local hub device* — "an order added to
a Toast POS device is sent to the local hub device, which distributes it to the
other devices" — so the floor keeps coordinating without the cloud. Where local
sync is unavailable their guidance matches our failure exactly: devices "cannot
sync with each other while offline", and staff are told to nominate one device
for the whole outage. Card payments queue and authorise on reconnect. Kiosks,
EMV chip, gift cards and loyalty stop.

**Square** caps offline card payments at 24 hours from the first offline
transaction, and the merchant absorbs declines. A risk limit, not a technical
one.

**Aloha and Micros** invert it: a back-of-house server on the LAN is the traffic
controller and the cloud is optional. Terminals drop to a degraded standalone
mode if it dies — full offline capability, but the BOH server becomes a single
point of failure.

**On sync**, the current consensus is that last-write-wins is simple and
dangerous, silently discarding data. CRDTs merge without coordination; event
sourcing keeps an immutable append-only log.

**On offline login**, the standard (Windows LSA, SSSD) is to cache a *verifier* —
a hash that validates a password locally but cannot be replayed elsewhere —
never the credential, with a bounded lifetime.

Toast's hub election does not transfer to us: a browser PWA cannot accept
inbound LAN connections, and Toast ships native apps. Our shape is Aloha's, with
the cloud kept live rather than optional.

## Architecture

**The local server is authoritative for what happens in the room.** Orders,
tables, kitchen tickets, tabs, payments, clock-ins. Tablets talk to it over the
cafe WiFi. This is true whether or not the internet is up, which is the point:
an outage stops being a special case, because the room never depended on the
line. It is also faster — nothing crosses an ocean.

**The cloud is not a mirror.** `src/auth.js` lets the public internet write
three things with no session: `POST /api/reservations`, `POST /api/orders`,
`POST /api/reviews`. Online bookings, online orders and reviews arrive at
Cloudflare from customers' phones. If the cafe's line is down but the customer's
mobile data is not, those keep landing somewhere the local box cannot see.

So there are two writers with different jobs, not a primary and a copy:

| | owns |
|---|---|
| **Local server** | the room: orders taken in-venue, tables, kitchen state, tabs, payments, timeclock |
| **Cloud** | the outside world: web orders, online reservations, reviews, the published menu, backoffice and reporting |

### Why this needs no CRDT

One venue means one writer at a time for almost everything. The two sides mostly
write *different records* — an in-venue order and a web order have different ids,
payments are append-only rows, stock movements are already a ledger, `audit_log`
is already an event stream. Union those and you are finished.

The real work is the small set of rows both sides can change.

### Ownership on conflict

| Entity | Rule |
|---|---|
| `orders`, `order_items` | Creator owns. In-venue orders are never edited by the cloud during an outage, and vice versa. |
| `payments` | Append-only. Union; never merge a row. |
| `tables` | **Local wins.** The box is watching the actual floor; the cloud is guessing. |
| `inventory` ledger | Append-only movements. Union, then recompute levels. |
| `reservations` | **Cloud wins.** Customers book there. Local-created bookings carry a local id prefix. |
| `menu`, prices | **Cloud wins.** Pricing is a back-office decision. |
| menu availability (86ing) | **Local wins** while offline — the kitchen knows what it has run out of — pushed up on reconnect. |
| `staff`, `settings` | **Cloud wins.** Provisioning is a manager action, not a service-floor one. |
| `timeclock` | Local wins. Clocking on happens in the room. |
| `audit_log` | Append-only. Union. |

### Sync protocol

Both sides keep an append-only outbox of `(site_id, seq, entity, entity_id, op,
payload, at)`, with `seq` monotonic per site.

On reconnect:

1. Push the local outbox from the last acknowledged `seq`. The receiver applies
   idempotently keyed on `(site_id, seq)`, so a retry after a dropped connection
   cannot double-apply.
2. Pull cloud changes since the local cursor and apply under the same rules.
3. Where both sides touched a shared-mutable row, the ownership table decides.
   Timestamp is a tiebreak only within the same owner.
4. Anything refused goes to a reconciliation list a manager can see. It must
   never be silently dropped — that is the exact failure the research warns
   about with last-write-wins.

Ordering matters within an entity, not across entities: replay per `entity_id`
in `seq` order.

### Runtime

Database access is almost entirely funnelled through `d1Query` and `d1Run` in
`src/lib/db.js`, which wrap `prepare().bind().all()` and `.run()`. Only
`orders.js` and `recipes.js` reach past them, for `env.DB.batch()` and
`env.DB.prepare()`.

So the local server does not need a port. Implement an object exposing
`prepare`, `bind`, `all`, `run`, `first` and `batch` over SQLite, pass it as
`env.DB`, and **the existing handlers run unchanged**. D1 is SQLite underneath,
so the SQL is already compatible. Roughly a hundred lines of adapter, plus a
small HTTP server mapping Node requests onto the existing `fetch(request, env)`
entry point.

Built in `local/`, and this held: the entire Worker runs on it with no change to
`src/`. Two corrections to the sketch above.

**Not `better-sqlite3`.** `node:sqlite` is built into Node 22.5+, so there is no
native module to compile — which means the Docker image needs no build toolchain
and the box never compiles anything over the connection whose absence is the
reason it exists. A dependency avoided is a dependency that cannot fail on a
Friday night.

**The adapter's governing rule is that it must never be more permissive than
D1**, or a bug that should fail locally ships to Cloudflare instead. Three real
divergences had to be closed: D1 accepts booleans and the driver refuses them,
the driver returns null-prototype rows where D1 returns ordinary objects, and
`batch()` had to be a genuine transaction because `orders.js` puts an order and
its lines in as one. `foreign_keys` is forced on for the same reason — SQLite
defaults it off, D1 enforces constraints.

KV and R2 needed shims too, which the sketch missed: six namespaces (backed by a
table in the same SQLite file, so there is one thing to back up) and the images
bucket (a directory). Their surface turned out to be tiny — get/put/delete, and
put/get.

The alternative — running Cloudflare's `workerd` locally so the runtime is
identical — is more faithful, but `wrangler dev` is a development tool and it
should not be the thing standing between the cafe and taking money on a Friday
night.

### Packaging

Docker, for one specific reason: **an image is atomic.** A `git pull` plus
`npm ci` over a poor connection can fail halfway and leave a broken server in a
building with nobody technical in it. An image either pulls or it does not, and
the running container is untouched until it does.

- SQLite lives on a **host bind mount**, never a container-managed volume. One
  `docker compose down -v` and the trading history is gone.
- `restart: unless-stopped`, so a power cut ends with everything running and no
  human involved.
- Multi-stage build on a slim base — the image is pulled over the same
  connection that is the problem in the first place.
- Pinned tags, updated deliberately and out of hours. No Watchtower: an image
  swapping itself mid-service is the wrong risk on a till.
- A healthcheck, and a nightly copy of the database off the box.

### Hardware

A mini PC (an N100-class box) over a Raspberry Pi. If a Pi is used, boot from
SSD — a SQLite database doing constant small writes is close to the worst case
for an SD card's write endurance. Either way a small UPS: losing power
mid-transaction is a worse problem than losing internet.

## Failure modes

| What fails | What happens |
|---|---|
| Internet down | The room is unaffected. Web orders and bookings accumulate in the cloud, unseen until reconnect. |
| Local box down | Tablets fall back to today's PWA behaviour: cached reads, queued writes, devices isolated. Degraded but trading. |
| Local box lost or stolen | Everything since the last successful sync is gone. This is why the nightly copy is not optional. |
| Both down | Paper. Every restaurant needs this plan and it belongs on the wall, not in a repo. |
| Clock skew between sites | Timestamps are a tiebreak only, never the primary rule, precisely so skew cannot decide who wins. |

## Decisions made

1. **Online ordering is refused while the venue is offline.** Enforced in the
   API, not only in the website: a cached page or a direct POST would sail past
   a UI flag, and the whole point is that no order enters a database the kitchen
   cannot see. The threshold is three missed 30-second heartbeats. Two
   consequences worth holding onto: a deployment with no box registered treats
   ordering as **open**, because otherwise this would have closed the shop the
   moment it shipped; and staff sessions are never refused, because the box
   being down while the line is up is exactly when tablets fall back to the
   cloud.
2. **No hard offline time limit.** Square's 24-hour cap exists to bound card
   fraud exposure; FU FUT is cash-heavy, so the same reasoning does not apply.
   What bounds the risk here instead is the nightly backup and the fact that the
   box is authoritative for the room — an outage is not a degraded mode, it is
   the normal one.
3. **The owner owns the box.** Practically that means somebody notices a red
   healthcheck and is willing to power-cycle it; the runbook is written for
   that person and assumes no knowledge of Docker.
4. **One venue.** `site_id` is fixed at `local` and `cloud` rather than
   provisioned. Every cursor and journal row is keyed on it, so a second venue
   is a configuration change rather than a migration — but the reconciliation
   and id-prefixing work that several venues would need is deliberately not
   built.

## Turning it on

Nothing above is live. Capture is gated on `SITE_ID`, which is commented out in
`wrangler.toml`, and the machine routes return 404 without `SYNC_TOKEN`. In
order:

1. `npx wrangler d1 execute fufut-db --remote --file migrations/014-sync.sql`
2. `npx wrangler secret put SYNC_TOKEN`
3. Uncomment `SITE_ID = "cloud"` in `wrangler.toml` and deploy.
4. Put the same `SYNC_TOKEN` and a `CLOUD_URL` in the box's `.env`.

Do 1 before 3. Capture is fail-open, so a Worker with `SITE_ID` set and no
`sync_outbox` keeps trading and logs an error per process — survivable, but not
a state to enter deliberately.

**The rehearsal has been done.** `wrangler deploy --env rehearsal` puts the
Worker on its own D1 database (`fufut-db-staging`) rather than production's —
the `fufut-api-staging` deploy in CI deliberately shares production's D1/KV/R2,
which makes it exactly the wrong place to rehearse something that writes rows.
A real box synced with it over the real internet: an order taken on the floor
reached D1 with its line items, a booking made through the public API reached
the box, a cloud-owned edit made locally surfaced as a conflict, and a repeat
run pushed nothing.

It found three things no local test could:

1. **`local/schema.sql` could not bootstrap a D1 database at all.** The dump
   included `_cf_KV`, D1's own internal table; SQLite creates it happily, D1
   refuses with `SQLITE_AUTH`. Removed.
2. **The box never learned its own pushes were refused.** Conflicts raised
   during a push happen on the far side, and the daemon ignored the count in
   the reply — a manager at a healthy box would have seen nothing wrong while
   refused writes piled up where they could not look.
3. **A rebuilt box lost everything, silently.** `seq` restarts at 1 when the
   outbox is recreated — a re-imaged box, or one restored from the nightly
   backup. The cloud compared those fresh low numbers against the cursor it
   remembered and skipped every one as already applied: no error, no conflict,
   an entire day's trading into a void. Journals now carry an `epoch`, and a
   cursor whose epoch no longer matches resets to zero. This is the one that
   would have hurt, because restoring from backup is exactly the moment you
   most need the writes to arrive.

## Staged plan

1. ~~**Offline hardening**~~ — **done.** Small, and independent of everything
   above: a signed-in session now survives an outage, and the banner tells staff
   plainly that other devices cannot see what they are entering. Worth doing
   whatever is decided here.
2. ~~**D1 adapter and local runtime**~~ — **done**, in `local/` (see
   `local/README.md`). The existing suite passes, and a new end-to-end test runs
   the real Worker against real SQLite — sign-in, an order with batched lines,
   the atomic table claim, KV, images, the cron sweep. Verified over HTTP and
   across a restart. It is a runtime, not a deployment: there is still no sync
   and no packaging.
3. ~~**Docker packaging, one box in the cafe**~~ — **done**, and verified end to
   end on the development machine: image builds, `docker compose up` goes
   healthy, the box serves the built POS and backoffice on the same origin as
   the API (the production bundles, no rebuild — the apps default to
   same-origin), and a backup taken inside the container lands on the host
   verified. `/_local/health` reads SQLite so a restart actually fixes
   something; nightly `VACUUM INTO` backups at 03:00; a seeding script for the
   rehearsal; `local/RUNBOOK.md` for the owner. Stage 3 still ends on hardware
   in the cafe — see `local/README.md`.
4. ~~**Sync engine**~~ — **done.** An append-only outbox on both sides, hooked
   into `d1Run`/`d1Batch` rather than into ~80 handler call sites; a 30-second
   push/pull daemon on the box; one shared ownership engine (`src/lib/`, not
   `local/`, because both sides run it and two copies would drift); and a
   reconciliation list for everything the rules refuse. Replay bypasses capture,
   or the two sides would journal each other's replays forever.
5. ~~**Cut over**~~ — **done** as far as it can be without hardware. Tablets
   already reach the box for both the app and the API (stage 3), and the cloud
   now refuses anonymous orders while the venue is quiet. What remains is
   physical: put a box in the cafe, seed it, point a tablet at it.
