# Running without the internet — local server design

**Status:** proposal, for review. Stages 1 and 2 are built (see the staged plan
at the end); stages 3 to 5 are not, and the four decisions below are still open.
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

## Decisions needed before building

1. **Should online ordering be refused while the venue is offline?** Accepting a
   delivery order the kitchen will never see is worse than telling the customer
   ordering is briefly closed. A business call, not a technical one.
2. **How long may the venue run offline before it demands attention?** Square
   chose 24 hours. FU FUT is cash-heavy, so the exposure is different.
3. **Who owns the box?** Somebody has to notice a failed healthcheck and be
   willing to power-cycle it.
4. **One venue, or eventually several?** The design holds for several, but the
   site-id and reconciliation work is only worth building once.

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
3. **Docker packaging, one box in the cafe**, pointed at by a single tablet with
   the cloud still primary. A rehearsal, not a migration. Should also serve the
   POS and backoffice bundles, which stage 2 does not — today only the API is
   local.
4. **Sync engine** — outbox on both sides, reconciliation list.
5. **Cut over**: tablets default to the local box; the cloud becomes the front
   door.
