# Putting the box in the cafe

One-time setup. Day-to-day lives in [RUNBOOK.md](RUNBOOK.md).

Allow **half a day**, and do it on a **quiet morning, never a Friday**. Nothing
here is difficult; it is just the first time, and the first time is when you
find the thing nobody thought of.

---

## What to buy

| | |
|---|---|
| **The box** | A mini PC, N100-class or better. 8 GB RAM, 128 GB SSD is plenty. |
| **Power** | A small UPS. Non-negotiable — losing power mid-write is a worse problem than losing internet, and this is a country where both happen. |
| **Network** | Wired ethernet to the router. WiFi for the box itself is one avoidable failure. |
| **Backup target** | A USB stick that lives in a drawer, or a second machine. |

**Not a Raspberry Pi on an SD card.** A SQLite database doing constant small
writes is close to the worst case for SD endurance, and it fails by corrupting
quietly rather than stopping. If it must be a Pi, boot from SSD.

---

## Before you go

Build the apps and bring them on the USB stick with everything else. The cafe's
connection is the thing you are working around; do not plan to download
anything there.

```
# in fufut-management/pos
npx vite build --base=/
# in fufut-management/backoffice
npx vite build --base=/backoffice/
```

On Git Bash, prefix with `MSYS_NO_PATHCONV=1` or `--base=/` gets rewritten into
a Windows path.

Take with you:

- the `fufut-api` repository
- `pos/dist` and `backoffice/dist`
- the Docker install for the box's OS
- the `SYNC_TOKEN`, if sync is being switched on (see the design doc)

---

## On the day

### 1. Give the box a fixed address

In the router's DHCP settings, reserve an address for the box's MAC. Write it
down; it goes on a card by the till.

Do this **first**. If the address moves later, every tablet stops finding the
box at once, and it will look like the box has failed.

### 2. Install Docker, then lay out the directory

```
mkdir -p ~/fufut/{data,web,backups}
cd ~/fufut
# copy docker-compose.yml, Dockerfile, src/, local/, package.json here
cp -r /media/usb/pos-dist/*        web/
mkdir -p web/backoffice && cp -r /media/usb/backoffice-dist/* web/backoffice/
```

The three directories are bind mounts, deliberately, so they are ordinary
folders anybody can see, copy and back up without knowing what Docker is.

### 3. Start it

```
docker compose up -d
docker compose ps          # fufut-local should say healthy
curl http://localhost:8787/_local/health
```

`fufut-backup` shows `Up` with no health state. That is correct — it runs no
server.

### 4. Put the real venue in it

An empty box proves nothing. Fill it from the live database:

```
docker compose exec api node /app/local/seed-from-cloud.js
```

This needs the internet, so do it while the line is up. It copies **real staff,
customer and payment records onto this machine** — from here the box deserves
the same care as the cloud database: a password on the machine, disk encryption
if the hardware supports it, and somewhere lockable to sit.

### 5. Point one tablet at it

Not all of them. One.

```
http://<the box's address>:8787/
```

Sign in and take a real order on it. The apps default to same-origin, so a
bundle served from the box talks to the box with nothing to configure.

**Run the whole shift like this**: one tablet on the box, everything else on
Cloudflare as usual. That is the rehearsal. If the box misbehaves, the cafe is
already trading normally on every other device and you simply take that tablet
off it.

### 6. Prove the backup before you trust it

Do not leave until you have restored one. The nightly job means nothing if the
restore does not work on this machine.

```
docker compose exec api node /app/local/backup.js
ls backups/
```

Then walk the restore in [RUNBOOK.md](RUNBOOK.md#restoring) once, on this box,
while somebody who knows the system is still standing next to it.

### 7. Copy the backup off the box

```
cp backups/*.sqlite /media/usb/
```

Set a reminder somebody will actually honour. Backups that live only on the
machine they protect are not backups — they cover mistakes and corruption, and
nothing else. A fire, a theft or a dead disk takes both.

---

## Then leave it alone for a week

One tablet, cloud still primary, nobody touching it. What you are watching for:

- does it stay `healthy` across a week, including power cuts
- does the nightly backup appear every morning
- does anyone complain that tablet is slower or stranger than the others

Only after that quiet week should more tablets move over, and only then is
switching sync on worth discussing.

---

## Leave this behind

Written on a card, by the till, in the language the staff use:

- the box's address
- `docker compose restart api` — what to try first
- who to call
- **that the cafe can trade with the box switched off**, because that is the
  thing worth knowing at 8pm on a Saturday

---

## What can go wrong on the day

| | |
|---|---|
| Tablets cannot reach the box | Almost always the address moved. Check the DHCP reservation. |
| `healthy` never arrives | `docker compose logs --tail 50 api`. Usually a mount path or a permission on `data/`. |
| The app loads but the API 401s | The bundle is being served from somewhere other than the box, so the cookie is not first-party. Check the URL is the box's address. |
| Assets 404 but the page loads | The bundle was built with the wrong `--base`. Rebuild. |
| Seeding fails | It needs the internet. Do it while the line is up. |
