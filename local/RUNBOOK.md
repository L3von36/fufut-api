# The box in the cafe — runbook

For whoever owns the machine. It assumes no knowledge of Docker.

Everything here is run from the folder holding `docker-compose.yml`, in a
terminal on the box.

---

## Is it working?

```
docker compose ps
```

`fufut-local` should say **healthy** (`starting` is fine for the first ten
seconds). `fufut-backup` just says **Up** — it runs no server, so it has no
health state to show. That is correct, not a fault.

For more detail:

```
curl http://localhost:8787/_local/health
```

A healthy answer looks like:

```json
{"ok":true,"uptime_s":41230,"database":"ok","staff":14,"web":"serving"}
```

`"database":"ok"` is the part that matters. The check reads from SQLite, so a
green light means the data is genuinely reachable, not merely that the program
is running.

---

## Starting and stopping

```
docker compose up -d       # start (and keep it started after a power cut)
docker compose logs -f     # watch what it is doing; Ctrl-C stops watching
docker compose restart     # restart, keeping all data
docker compose down        # stop
```

**Never run `docker compose down -v`.** The `-v` deletes volumes. The data is on
a normal folder rather than a Docker volume specifically so that this command
cannot take the trading history with it, but do not build the habit.

---

## The health check has gone red

Work down this list. Stop when it comes back.

**1. Look at what it is complaining about.**

```
docker compose logs --tail 50 api
```

**2. Restart it.**

```
docker compose restart api
```

This fixes the large majority of problems and loses nothing. Give it thirty
seconds, then check `docker compose ps` again.

**3. Is the disk full?**

```
df -h
```

A SQLite database on a full disk stops accepting writes, which looks like the
till breaking for no reason. If the disk is full, the backups folder is the
first place to look.

**4. Still red?**

The tablets fall back to working against Cloudflare on their own, as long as
the internet is up. **The cafe can keep trading** — the POS holds orders on the
device and syncs when it can. Take the paper fallback out if the internet is
down as well, and get somebody technical to the box.

---

## Backups

A snapshot is taken every night at 03:00 into `./backups`, and copies older than
14 days are deleted. To take one right now:

```
docker compose exec api node /app/local/backup.js
```

**Check them occasionally.** A backup nobody has looked at is not a backup. The
files are named `fufut-YYYY-MM-DD-HHMM.sqlite` and each one is verified as it is
written.

**These backups live on the same machine as the database.** That protects
against mistakes and corruption, and against nothing else — a fire, a theft or a
dead disk takes both. Copy the folder somewhere else on a schedule you can keep:
a USB stick in a drawer is worth more than a plan nobody follows.

### Restoring

Stop the server first. Restoring underneath a running server gives you a
corrupt database.

```
docker compose stop api
cp data/fufut.sqlite data/fufut.sqlite.broken       # keep the bad one
rm -f data/fufut.sqlite-wal data/fufut.sqlite-shm   # stale journals
cp backups/fufut-2026-08-18-0300.sqlite data/fufut.sqlite
docker compose start api
```

Then check `docker compose ps` says healthy, and open the POS.

**Everything entered between the backup and now is gone.** Know roughly what
that covers before you do it — a restore during service means re-entering the
day's orders from the printed tickets.

---

## Updating

### The server

```
docker compose build
docker compose up -d
```

Do this **out of hours**. The container is replaced, which is a few seconds of
downtime. The data folder is untouched.

Nothing updates itself. That is deliberate: an image swapping itself in the
middle of service is the wrong risk on a till.

### The POS and backoffice apps

The built apps live in `./web`, served straight off the disk:

```
web/index.html             a redirect, so the bare address opens the till
web/pos/                   the POS,        reached at /pos/
web/backoffice/            the backoffice, reached at /backoffice/
```

Replace the contents of `web/pos/` or `web/backoffice/` and reload the tablet.
No rebuild and no restart — the server reads from disk on every request.

Each app must go in the folder matching the path it was built for, because that
is what its asset URLs point at. Both are built with plain `npm run build`; the
paths come from their own vite configs and are the same ones Cloudflare serves
them at, so there is no box-specific build to keep track of.

---

## Pointing a tablet at the box

Open `http://<the box's address>:8787/` in the tablet's browser — it redirects
to the till. The backoffice is at `/backoffice/`.

Give the box a **fixed address** on the cafe's router first, or it will move and
the tablets will stop finding it.

The apps default to same-origin, so a bundle served from the box automatically
talks to the box's API. There is nothing to configure on the tablet.

---

## A power cut

Nothing to do. The container restarts by itself and SQLite recovers its journal.
Check `docker compose ps` when the power is back.

If power cuts are frequent, a small UPS is worth more than any of this: losing
power in the middle of a write is a worse problem than losing the internet.

---

## Is it syncing?

```
curl http://localhost:8787/_local/sync
```

```json
{"configured":true,"online":true,"pending":0,"unresolved":2,
 "last_success":"2026-08-18T13:40:02.113Z","last_error":null}
```

| Field | What it means |
|---|---|
| `configured` | false = this box has not been connected to the cloud at all |
| `online` | whether the cloud answered on the last try |
| `pending` | writes made here that the cloud has not acknowledged |
| `unresolved` | conflicts waiting for a manager (see below) |
| `last_success` | the last complete exchange |

This deliberately lives **on the box**, not in the cloud. A cloud-hosted "sync
is broken" flag cannot be read during the outage that broke it, which is the one
moment it matters.

**`online: false` is not an emergency.** It is the condition this whole system
was built for. The room carries on, writes queue, and they go up when the line
returns. What deserves attention is `online: true` with `pending` climbing and
`last_success` hours old — that means the box can reach the cloud and the
exchange is failing anyway. `docker compose logs --tail 50 api` will say why.

---

## "Ordering is temporarily closed" on the website

This is the system working as decided, not a fault. When the box has not
checked in for 90 seconds the cloud stops accepting orders from the public,
because an order taken then is one the kitchen never sees — the customer would
pay and wait for food nobody started.

To confirm:

```
curl https://fufut-api.fufutcoffee.workers.dev/api/venue/status
```

`online_ordering: false` means the cloud is not hearing from the box. Either the
internet is down, or the box is. **Staff can still take orders throughout** —
signed-in sessions are never refused, so the tablets keep working whichever
side they are talking to.

It reopens by itself within a minute of the box checking in again. Nothing to
press.

---

## Conflicts, and what they are

When both sides changed the same kind of thing, one of them wins by a rule —
the box wins about tables and the clock, the cloud wins about the menu, prices,
staff and bookings. **The losing write is never thrown away.** It is recorded so
a person can decide.

The commonest way to create one: using the backoffice on the box during an
outage to change a price or add a member of staff. Those are cloud-owned, so on
reconnect the change is refused and listed rather than applied.

To see the list, signed in as a manager:

```
curl -b <manager session> https://fufut-api.fufutcoffee.workers.dev/api/sync/reconciliation
```

Each entry says which side it came from, what it tried to do, and why it was
refused. **There is no screen for this yet** — the list and the API exist, the
backoffice view does not.

Resolving one means doing it again on the winning side. If a price was changed
on the box during an outage and refused, change it again in the backoffice once
the line is back. There is no button that replays it for you, deliberately:
these are decisions, and a price is not something to re-apply without somebody
looking at it.

---

## What this box does not do yet

Be clear about these, because they are the difference between a rehearsal and a
migration.

**Card payments and anything that calls out to the internet cannot work while
the line is down**, no matter how healthy this box is.

**Sync may not be switched on.** Check `configured` at `/_local/sync`. If it
says false, nothing moves between this box and the cloud in either direction:
anything entered here stays here, and online bookings never arrive. The code is
built and tested; connecting it is a deliberate step somebody has to take.

**There is no reconciliation screen.** Conflicts are visible through the API
only, as above. Somebody has to go looking rather than being told.

---

## Security

The server listens on every network interface so the tablets can reach it. It
must **never** be port-forwarded to the internet — the cloud Worker is the front
door and this is not it.

The box holds real customer and staff data, including password hashes. It
deserves the same care as the cloud database: a password on the machine, disk
encryption if the hardware supports it, and somewhere lockable to sit.
