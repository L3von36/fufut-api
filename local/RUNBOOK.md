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
web/index.html             the POS, built with --base=/
web/backoffice/index.html  the backoffice, built with --base=/backoffice/
```

Replace the files and reload the tablet. No rebuild and no restart — the server
reads from disk on every request.

The base a bundle is built with has to match where it is mounted, because that
is what its asset URLs point at. A POS built with `--base=/` cannot be served
from a subfolder.

---

## Pointing a tablet at the box

Open `http://<the box's address>:8787/` in the tablet's browser.

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

## What this box does not do yet

Be clear about these, because they are the difference between a rehearsal and a
migration.

**It does not sync.** Nothing moves between the box and Cloudflare in either
direction. Anything entered on the box exists only on the box, and anything
entered in the cloud — online orders, web bookings, reviews — never reaches the
box. This is stage 4 of the design.

**During an internet outage, orders from outside still land in the cloud** where
nobody in the building can see them. Until sync exists, an outage means checking
online orders by hand once the line is back.

**Card payments and anything that calls out to the internet cannot work while
the line is down**, no matter how healthy this box is.

---

## Security

The server listens on every network interface so the tablets can reach it. It
must **never** be port-forwarded to the internet — the cloud Worker is the front
door and this is not it.

The box holds real customer and staff data, including password hashes. It
deserves the same care as the cloud database: a password on the machine, disk
encryption if the hardware supports it, and somewhere lockable to sit.
