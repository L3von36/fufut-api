# The FU FUT API, packaged for a box in the cafe.
#
# Docker is here for one reason from the design doc: an image is atomic. A
# `git pull` plus `npm ci` over a bad connection can fail halfway and leave a
# broken server in a building with nobody technical in it. An image either
# pulls or it does not, and the running container is untouched until it does.
#
# There is no build stage and no `npm ci`, because there is nothing to install:
# the Worker imports nothing outside `node:*`, and SQLite is built into Node.
# The image is Node plus this repository's source. Nothing to compile means no
# build toolchain; no runtime dependencies means no supply chain on the till and
# a small image, which matters when it is pulled over the same connection whose
# absence is the reason the box exists.
#
#   docker build -t fufut-local .
#   docker run -p 8787:8787 -v ./data:/data fufut-local
#
# Prefer docker-compose.yml, which sets the mount and restart policy correctly.

FROM node:24-slim

# Pinned deliberately and updated out of hours. Node 24 is what `node:sqlite`
# needs without an experimental flag.
ENV NODE_ENV=production \
    FUFUT_DATA_DIR=/data \
    FUFUT_BACKUP_DIR=/backups \
    PORT=8787 \
    HOST=0.0.0.0

WORKDIR /app

# Source only. package.json comes along for `type: module` and the engines
# field, not for its dependencies.
COPY package.json ./
COPY src/ ./src/
COPY local/ ./local/

# `node` is an unprivileged user the base image already provides. The till has
# no business running as root, and the data directory has to be writable by
# whoever it does run as.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8787

# Checks the database answers, not merely that the process is alive — a server
# that is up but cannot reach SQLite is exactly the state a restart fixes and a
# liveness-only check hides. Uses Node's own fetch; there is no curl in slim.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/_local/health').then(r=>r.json()).then(b=>process.exit(b.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "local/server.js"]
