#!/usr/bin/env node
/**
 * The FU FUT API, running on a box in the cafe.
 *
 * This is a host for the existing Worker, not a reimplementation of it. It
 * translates a Node request into a `Request`, hands it to the very same
 * `fetch(request, env, ctx)` that Cloudflare calls, and writes the `Response`
 * back out. The routing, the auth, the handlers and the SQL are untouched.
 *
 *   node local/server.js            # listens on 0.0.0.0:8787
 *   FUFUT_DATA_DIR=/data node local/server.js
 *
 * It binds all interfaces on purpose: the tablets reach it across the cafe
 * WiFi, so localhost-only would defeat the point. That also means it must never
 * be exposed to the internet by a router's port forwarding — the cloud Worker
 * is the front door, and this is not it.
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import worker from '../src/index.js';
import { createLocalEnv } from './env.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
/** Matches the `crons = ["* * * * *"]` trigger in wrangler.toml. */
const CRON_INTERVAL_MS = 60_000;

const { env, dbPath, dir } = createLocalEnv();

/**
 * `ctx.waitUntil` on Cloudflare keeps the isolate alive for work started but
 * not awaited. Here the process is already alive, so the job is only to make
 * sure a rejection surfaces in the log instead of becoming an unhandled
 * rejection that takes the server down mid-service.
 */
function createContext() {
  const pending = [];
  return {
    ctx: {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise).catch((err) => console.error('[fufut] waitUntil failed:', err)));
      },
      passThroughOnException() {},
    },
    settled: () => Promise.all(pending),
  };
}

function toRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: 'half',
  });
}

async function writeResponse(response, res) {
  const headers = {};
  for (const [key, value] of response.headers) {
    // Set-Cookie may legitimately appear more than once; everything else is
    // flattened by the Headers iterator anyway.
    if (key.toLowerCase() === 'set-cookie') {
      headers['set-cookie'] = response.headers.getSetCookie?.() || [value];
    } else {
      headers[key] = value;
    }
  }
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).pipe(res).on('finish', resolve).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const { ctx, settled } = createContext();
  try {
    const response = await worker.fetch(toRequest(req), env, ctx);
    await writeResponse(response, res);
    await settled();
    console.log(`${req.method} ${req.url} ${response.status} ${Date.now() - started}ms`);
  } catch (err) {
    // A handler throwing must not take the till down with it.
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Local server error' }));
    } else {
      res.end();
    }
  }
});

/**
 * The cron trigger, which on the cloud runs every minute: scheduled publishing
 * and the overstayed-table sweep. Those matter more here, not less — this is
 * the box that knows which tables are actually occupied.
 */
let cronRunning = false;
const cron = setInterval(async () => {
  if (cronRunning) return; // A slow sweep must not stack up behind itself.
  cronRunning = true;
  const { ctx, settled } = createContext();
  try {
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, ctx);
    await settled();
  } catch (err) {
    console.error('[fufut] scheduled task failed:', err);
  } finally {
    cronRunning = false;
  }
}, CRON_INTERVAL_MS);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[fufut] ${signal} — closing`);
    clearInterval(cron);
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`[fufut] local API on http://${HOST}:${PORT}`);
  console.log(`[fufut] data in ${dir}`);
  console.log(`[fufut] database ${dbPath}`);
});
