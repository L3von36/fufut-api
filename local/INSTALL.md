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
cd fufut-management/pos        && npx vite build --base /
cd fufut-management/backoffice && npx vite build --base /backoffice/
```

**Ignore `vite.config.js`.** Both configs say `/pos/` and `/backoffice/`, and
neither is what production uses: `.github/workflows/build-pos.yml` overrides
both with `--base /`, and each app is deployed to its own subdomain root. The
config is a trap — it looks authoritative and is dead.

The POS in particular **must** be at the origin root, because
`src/main.js` registers its service worker as `navigator.serviceWorker
.register('/sw.js')` and `public/sw.js` caches `/pos/`, `/assets/logo.webp` and
`/favicon.svg` — all root-absolute. `/pos/` there is one of the app's own
client-side routes, not a folder. Served from a subdirectory the registration
404s into the API, comes back 401, and the till loses its offline cache: the one
capability the box exists to protect.

The backoffice has no service worker, so it is happy under `/backoffice/` —
which is what lets both apps share one origin on the box when production gives
each a subdomain of its own.

The bundles reference Google Fonts. With no internet the browser falls back to
a system font: the till looks slightly different and works identically.

### Export the venue's data now, not there

```
npx wrangler d1 export fufut-db --remote --output fufut-dump.sql -y
```

Do this on a machine already signed in to Cloudflare. It cannot be done on the
box: wrangler is not in the Docker image — there is no `npm ci`, which is what
keeps the image small and free of a runtime supply chain — and exporting needs
credentials anyway, with `wrangler login` wanting a browser that a headless mini
PC behind a counter does not have.

Take with you:

- the `fufut-api` repository
- `pos/dist` and `backoffice/dist`
- **`fufut-dump.sql`**
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
mkdir -p web/backoffice
cp -r /media/usb/pos-dist/.        web/
cp -r /media/usb/backoffice-dist/. web/backoffice/
```

The finished layout:

```
web/index.html             the POS, at the origin root
web/sw.js                  its service worker — must be here, not nested
web/assets/                its assets
web/backoffice/            the backoffice, at /backoffice/
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

An empty box proves nothing. Fill it from the dump you brought:

```
cp /media/usb/fufut-dump.sql ~/fufut/data/
docker compose exec api node /app/local/seed-from-cloud.js --from-file /data/fufut-dump.sql
```

No network, no credentials on the box. It refuses to run if the database
already holds orders, so it cannot quietly undo a day's trading — pass `--force`
only when you mean it.

It copies **real staff, customer and payment records onto this machine**. From
here the box deserves the same care as the cloud database: a password on the
machine, disk encryption if the hardware supports it, and somewhere lockable to
sit. Delete the dump from the USB stick when you are done with it.

### 5. Point one tablet at it

Not all of them. One.

```
http://<the box's address>:8787/            # the till
http://<the box's address>:8787/backoffice/
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
| Assets 404 but the page loads | The bundle is in the wrong folder, or built with the wrong `--base`. The POS goes at the root of `web/`, the backoffice in `web/backoffice/`. |
| Assets 401, or the page is an old version | A stale service worker from an earlier build on that address. In the browser: DevTools → Application → Service Workers → Unregister, then hard-reload. The 401s are the cached app asking for paths that no longer exist and falling through to the API. |
| Seeding fails | Use `--from-file` with the dump you brought. The container has no wrangler and no Cloudflare credentials, by design. |
