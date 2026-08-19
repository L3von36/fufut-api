# Setting up the local server by hand

Everything needed to take a bare machine and end up with a working till.

There are three documents and they do different jobs:

| | |
|---|---|
| **SETUP.md** (this one) | the complete manual reference — every option, every step |
| [INSTALL.md](INSTALL.md) | the abbreviated sequence for installation day in the café |
| [RUNBOOK.md](RUNBOOK.md) | day-to-day operation once it is running |

---

## 1. What you are installing

The same API that runs on Cloudflare, hosted on a machine in the building, plus
the POS and backoffice served from that same machine. Tablets talk to it over
the local network, so the room keeps working when the internet does not.

It is **not** a rewrite. `local/server.js` translates a Node request into a
`Request`, hands it to the identical `fetch(request, env, ctx)` that Cloudflare
calls, and writes the `Response` back. `src/` does not know it is running here.

---

## 2. Requirements

**Node 24 or newer.** SQLite is built into Node from 22.5, but needs an
experimental flag before 24. Node 24 is what this is tested on.

**No `npm install` for the server.** It imports nothing outside `node:*`. That
is why the whole thing moves between machines as a folder copy, and why the
Docker image needs no build toolchain.

**Docker** only if you want the packaged route (section 4b). Optional.

**Disk:** the database and images are a few hundred MB. Allow a few GB for
backups.

---

## 3. Getting the files onto the machine

Copy these from a working machine, or clone the repo and add the rest:

```
fufut-api/
  src/            the Worker — the actual application
  local/          the host, the adapters, the scripts
  package.json    needed for "type": "module"
  Dockerfile      only for the Docker route
  docker-compose.yml
  web/            the built POS and backoffice   (see section 6)
  data/           the database and the images    (see section 5)
```

Do **not** copy `node_modules`. Nothing at runtime needs it.

`data/`, `web/` and `backups/` are excluded from git on purpose: they are
trading data and build output, not source.

---

## 4. Running it

### 4a. Directly with Node — simplest

**PowerShell:**

```powershell
cd C:\path\to\fufut-api
$env:FUFUT_DATA_DIR   = "$PWD\data"
$env:FUFUT_WEB_DIR    = "$PWD\web"
$env:FUFUT_BACKUP_DIR = "$PWD\backups"
$env:HOST = "0.0.0.0"
$env:PORT = "8787"
node local/server.js
```

**Linux / macOS:**

```bash
cd /path/to/fufut-api
export FUFUT_DATA_DIR="$PWD/data"
export FUFUT_WEB_DIR="$PWD/web"
export FUFUT_BACKUP_DIR="$PWD/backups"
export HOST=0.0.0.0 PORT=8787
node local/server.js
```

It prints where its data is and what it is serving. Leave the window open —
that process **is** the till. Nothing restarts it if it stops, which is the main
reason the café box should use Docker instead.

### 4b. With Docker — what the café box should use

```
docker compose up -d      # build, start, keep started
docker compose ps         # fufut-local should say healthy
docker compose logs -f    # watch it
```

Why: an image is atomic. A `git pull` plus install over a bad connection can
fail halfway and leave a broken server in a building with nobody technical in
it. An image either pulls or it does not. It also restarts itself after a power
cut, and brings the nightly backup container with it.

`fufut-backup` shows `Up` with no health state — correct, it runs no server.

### Running it as a service (Linux)

If you want it to survive reboots without Docker, a systemd unit:

```ini
[Unit]
Description=FU FUT local server
After=network.target

[Service]
WorkingDirectory=/opt/fufut-api
Environment=FUFUT_DATA_DIR=/opt/fufut-api/data
Environment=FUFUT_WEB_DIR=/opt/fufut-api/web
Environment=FUFUT_BACKUP_DIR=/opt/fufut-api/backups
Environment=HOST=0.0.0.0
Environment=PORT=8787
ExecStart=/usr/bin/node local/server.js
Restart=always
User=fufut

[Install]
WantedBy=multi-user.target
```

---

## 5. Configuration

Everything is environment variables. None are required — the defaults give a
working, unconnected box.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Interfaces to bind. All of them, so tablets can reach it. **Never port-forward this to the internet** — the cloud Worker is the front door |
| `FUFUT_DATA_DIR` | `<repo>/data` | The SQLite file and the image bucket. The only directory with state in it |
| `FUFUT_WEB_DIR` | *(unset)* | Where the built apps live. Unset means API only, no screens |
| `FUFUT_BACKUP_DIR` | `<data>/backups` | Where snapshots are written. The Docker image sets `/backups` |
| `FUFUT_BACKUP_KEEP_DAYS` | `14` | Age at which old snapshots are pruned |
| `TZ` | system | Set to `Africa/Addis_Ababa` so logs and daily rollups match the venue |
| `SITE_ID` | `local` | This side's identity for sync |
| `CLOUD_URL` | *(unset)* | The cloud API. **Sync stays off unless this and `SYNC_TOKEN` are both set** |
| `SYNC_TOKEN` | *(unset)* | Shared secret for the machine-to-machine sync routes |
| `FUFUT_D1_NAME` | `fufut-db` | Which D1 database `seed-from-cloud.js` exports |
| `FUFUT_CLOUD_ORIGIN` | the production Worker URL | Where `mirror-images.mjs` fetches photographs from |

With Docker, put these in `docker-compose.yml`, except secrets — put
`CLOUD_URL` and `SYNC_TOKEN` in a `.env` file beside it, because the compose
file is committed.

---

## 6. The data

A fresh `FUFUT_DATA_DIR` gets `local/schema.sql` applied automatically and
nothing else: no staff, no menu, no tables. Nobody can sign in. You need one of
the three below.

### Easiest — copy an existing `data/` folder

**Stop the source server first.** SQLite runs in WAL mode; copying a live
database can give you a file that will not open.

```
data/fufut.sqlite     the database
data/images/          the menu photographs
```

That is the whole state. Copy the folder, start the server, done — no network
needed.

### From the live database

Two steps, both needing internet.

**Export on a machine already signed in to Cloudflare** — not on the box.
Wrangler is not in the Docker image, and `wrangler login` wants a browser that
a headless machine does not have:

```
npx wrangler d1 export fufut-db --remote --output fufut-dump.sql -y
```

**Apply it on the box:**

```
node local/seed-from-cloud.js --from-file fufut-dump.sql
```

It refuses if the database already holds orders. `--force` overrides that; mean
it when you use it.

**Then the photographs**, which the dump does not contain — it holds only
references to them:

```
node local/mirror-images.mjs
```

Skip this and every dish renders with a broken image while the data looks
complete.

### A note on what you are copying

Real staff records, customer names and phone numbers, password hashes. From
that moment the machine deserves the same care as the cloud database: a password
on it, disk encryption if the hardware supports it, somewhere lockable to sit.

---

## 7. The apps

### Layout

```
web/index.html      the POS, at the root
web/assets/         its assets
web/sw.js           its service worker  — must be at the root, not nested
web/backoffice/     the backoffice
```

### The URLs

```
http://<host>:8787/pos/            the till
http://<host>:8787/backoffice/     the backoffice
```

**`/pos/` and not `/`.** The POS is *served* from the root, but its router is
created with `createWebHistory('/pos/')`, so its own routes live under `/pos/`.
Opening `/` loads the page and renders nothing, which looks like a broken app.

### Building them

Both come from `fufut-management`, and there are two traps.

**Restore the template first.** `pos/index.html` in the repo is build *output*,
not a source template — the deploy workflow overwrites it and commits it back.
Building from it re-bundles the previously built app: it finishes in a second,
ignores everything in `src/`, and emits chunks with two hashes. CI restores the
template on the line before it builds; do the same:

```
cd fufut-management/pos
cp index.html.source index.html
npx vite build --base=/

cd ../backoffice
cp index.html.source index.html
npx vite build --base=/backoffice/
```

**On Git Bash, prefix with `MSYS_NO_PATHCONV=1`**, or `--base=/` is rewritten to
`/Program Files/Git/` and every asset URL is wrong. Building from PowerShell
avoids it entirely.

Then copy `pos/dist/*` into `web/` and `backoffice/dist/*` into
`web/backoffice/`.

Ignore the `base` values in `vite.config.js` — CI overrides them and production
has never used them.

---

## 8. The network

**Give the machine a fixed address** on the router, by DHCP reservation. Do this
before anything else: if the address moves later, every tablet stops finding the
box at once and it looks like the box has failed.

**Open the port.** On Windows, from an Administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "FU FUT box (8787)" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private,Public
```

Check which profile your network is on first — `Get-NetConnectionProfile`. A
`Private`-only rule does nothing on a network Windows has classified `Public`.

Most Linux boxes need nothing; if `ufw` is active, `ufw allow 8787/tcp`.

### About HTTPS

Over plain `http://` the browser refuses to register the service worker, so the
POS runs **without its offline cache** — the capability the box exists to
provide. `localhost` is exempt, which is how this hides during development.

Options, best last:

- **Tailscale** — real certificate, nothing to install per tablet, but every
  tablet needs the client and an account, and re-authentication needs the
  internet. Fine for a rehearsal; a poor foundation for the thing whose job is
  surviving an outage.
- **Self-signed certificate** — works offline, but the CA must be installed on
  every tablet.
- **A real domain pointing at the LAN address** — `box.fufutcoffee.com` →
  `192.168.1.7`, with a Let's Encrypt certificate obtained by DNS-01
  validation. Browser-trusted, nothing per tablet, and it keeps working through
  an outage because the certificate is already on disk. Renewal needs internet
  every 90 days, which any day the line is up will cover.

---

## 9. Sync — optional, off by default

Without `CLOUD_URL` and `SYNC_TOKEN` the box journals its writes and talks to
nobody. Turning it on, in this order:

1. `npx wrangler d1 execute fufut-db --remote --file migrations/014-sync.sql`
2. `npx wrangler secret put SYNC_TOKEN`
3. Uncomment `SITE_ID = "cloud"` in `wrangler.toml` and deploy
4. Put the same `SYNC_TOKEN` and a `CLOUD_URL` in the box's environment

Step 1 before step 3. Capture is fail-open, so a Worker with `SITE_ID` set and
no `sync_outbox` keeps trading and logs an error per process — survivable, but
not a state to enter deliberately.

Rehearse against a staging Worker first. See [../LOCAL-SERVER-DESIGN.md](../LOCAL-SERVER-DESIGN.md).

---

## 10. Checking it works

```
curl http://localhost:8787/_local/health
```

```json
{"ok":true,"uptime_s":41230,"database":"ok","staff":14,"web":"serving"}
```

`"database":"ok"` is the part that matters — the check reads from SQLite, so
green means the data is genuinely reachable rather than merely that the program
is running. `"web":"serving"` means it found the apps; `"api-only"` means
`FUFUT_WEB_DIR` is unset or wrong.

```
curl http://localhost:8787/_local/sync
```

Reports `configured`, `online`, `pending`, `unresolved`, `last_success`. This
lives on the box on purpose: a cloud-hosted "sync is broken" flag cannot be read
during the outage that broke it.

Then open the till from a tablet and take a real order.

---

## 11. Backups

A snapshot is written nightly at 03:00 into `FUFUT_BACKUP_DIR`, and copies older
than `FUFUT_BACKUP_KEEP_DAYS` are removed. On demand:

```
node local/backup.js
docker compose exec api node /app/local/backup.js     # Docker
```

It uses `VACUUM INTO`, not a file copy — in WAL mode the `.sqlite` file alone is
not the database, and a copy taken mid-write restores to a corrupt state. Each
snapshot is verified by opening it before the script claims success.

**Copy them off the machine.** Backups that live only on the machine they
protect cover mistakes and corruption and nothing else; a fire, a theft or a
dead disk takes both.

Restoring is in [RUNBOOK.md](RUNBOOK.md#restoring). Practise it once before you
need it.

---

## 12. Troubleshooting

| Symptom | Cause |
|---|---|
| `"web":"api-only"` in health | `FUFUT_WEB_DIR` unset, or pointing at a directory that does not exist |
| Page loads, renders nothing | Opened `/` instead of `/pos/` |
| Assets 404 | Bundle in the wrong folder, or built with the wrong `--base` |
| Assets 401, or an old version appears | Stale service worker. DevTools → Application → Service Workers → Unregister, then reload |
| Tablets cannot reach it | Address moved (check the DHCP reservation), or the firewall rule is missing or on the wrong profile |
| `EACCES` on the port | Windows reserves scattered port ranges; pick another port |
| Health red, database error | Disk full, or a permissions problem on `FUFUT_DATA_DIR` |
| Nobody can sign in | The database was never seeded — section 6 |
| Dish images broken | `mirror-images.mjs` was never run |
| A local rebuild changes nothing | `index.html` was not restored from `index.html.source` |

---

## 13. Security

The server binds every interface so tablets can reach it. It must **never** be
exposed to the internet by port forwarding — the cloud Worker is the front door
and this is not it.

There are no credentials on the box: no Cloudflare token, no wrangler. Seeding
and image mirroring are done with files carried in, or against the public image
route.

The machine holds real customer and staff data. Treat it accordingly.
