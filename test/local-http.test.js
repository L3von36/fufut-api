/**
 * The HTTP layer of the box — static serving and the container healthcheck.
 *
 * local-runtime.test.js calls `worker.fetch` directly, which cannot see the
 * parts that only exist around the Worker: the static file server that hands
 * the tablet its app, and `/_local/health`, which Docker polls. Both live in
 * local/server.js, so this file runs that server as a real child process and
 * speaks HTTP to it — the same way the cafe's tablets will.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalD1 } from '../local/d1.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'local', 'server.js');

/**
 * Start the server and resolve when /_local/health first answers.
 *
 * The port is random so the suite can run beside anything else, including a
 * development copy of the server on its default 8787.
 */
async function startServer(dataDir, webDir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FUFUT_DATA_DIR: dataDir,
      ...(webDir ? { FUFUT_WEB_DIR: webDir } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const probe = await fetch(`${base}/_local/health`);
      if (probe.status > 0) return { child, base, output };
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server did not start within 20s.\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

let dir;
let web;
let child;
let base;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-http-'));

  // A built-app layout: the POS at the root, the backoffice in a
  // subdirectory, one fingerprinted asset, and a stray file that must never
  // be allowed to answer an /api/* request.
  web = path.join(dir, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(web, 'backoffice'), { recursive: true });
  fs.mkdirSync(path.join(web, 'api'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<html>pos-shell</html>');
  fs.writeFileSync(path.join(web, 'backoffice', 'index.html'), '<html>backoffice-shell</html>');
  fs.writeFileSync(path.join(web, 'assets', 'app-4f8c1a2b9d.js'), "console.log('app')");
  fs.writeFileSync(path.join(web, 'api', 'index.html'), '<html>stray-api-file</html>');

  ({ child, base } = await startServer(path.join(dir, 'data'), web));
}, 30_000);

afterAll(() => {
  child?.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a file briefly */ }
});

describe('/_local/health', () => {
  it('answers 200 with the database reachable', async () => {
    const response = await fetch(`${base}/_local/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.database).toBe('ok');
    expect(body.web).toBe('serving');
  });

  it('answers 503 when the database cannot answer', async () => {
    /**
     * A healthcheck that only proves the process is up is worth little — the
     * state a restart fixes is "up but blind". This is that state, for real:
     * a valid SQLite file that has never had the FU FUT schema applied, so
     * the staff count the endpoint relies on cannot run. createLocalEnv
     * leaves it alone because it is not empty; only the probe notices.
     */
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'fufut-blind-'));
    try {
      const { db } = openLocalD1(path.join(broken, 'fufut.sqlite'));
      db.exec('CREATE TABLE decoy (id INTEGER PRIMARY KEY)');
      db.close();

      const blind = await startServer(broken, web);
      try {
        const response = await fetch(`${blind.base}/_local/health`);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.ok).toBe(false);
      } finally {
        blind.child.kill();
      }
    } finally {
      try { fs.rmSync(broken, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }, 30_000);
});

describe('the built apps are served', () => {
  it('hands out the root shell uncached', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    // index.html must never be cached hard, or an update to the box leaves
    // the tablets running the previous app until their cache expires.
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(await response.text()).toContain('pos-shell');
  });

  it('caches fingerprinted assets immutably', async () => {
    const response = await fetch(`${base}/assets/app-4f8c1a2b9d.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/javascript');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
  });

  it('lands a backoffice client-side route on the backoffice shell', async () => {
    /**
     * /backoffice/payroll exists only in the browser's router. Serving the
     * root POS shell here would put the wrong application on a manager's
     * screen — the shell-walk exists for exactly this case.
     */
    const response = await fetch(`${base}/backoffice/payroll`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('backoffice-shell');
    expect(body).not.toContain('pos-shell');
  });
});

describe('the API always wins over the web directory', () => {
  it('never serves a stray file for an /api/* path', async () => {
    /**
     * web/api/index.html is sitting there deliberately. If the static server
     * ever picked it up for /api/health, a file in an app bundle could
     * shadow a real endpoint and take the till offline.
     */
    const response = await fetch(`${base}/api/health`);
    expect([401, 404]).toContain(response.status);
    expect(await response.text()).not.toContain('stray-api-file');
  });
});

describe('a missing asset is a miss, not a shell', () => {
  it('does not answer HTML for a file that is not there', async () => {
    /**
     * The SPA fallback must not apply to anything with an extension. Getting
     * index.html back for a missing .js file makes the browser report a
     * syntax error in the app instead of a missing file — far harder to
     * diagnose over the phone.
     */
    const response = await fetch(`${base}/assets/absent-0000000000.js`);
    // The Worker answers before its own 404 when there is no session; either
    // way the point is that no shell was served.
    expect([401, 404]).toContain(response.status);
    expect(response.headers.get('Content-Type') || '').not.toContain('text/html');
    expect(await response.text()).not.toContain('pos-shell');
  });
});

describe('paths cannot climb out of the web root', () => {
  /**
   * These were throwaway probes when static.js was written; they are
   * committed now because they guard the one function with file-system
   * reach. Both forms must resolve inside the web root — landing on the SPA
   * shell is fine, reading a file outside it is not.
   */
  it('contains encoded traversal', async () => {
    // fetch keeps %2F encoded in the request line, so the server is the first
    // thing to decode it.
    const response = await fetch(`${base}/..%2f..%2fetc/passwd`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('pos-shell'); // the shell, never the system file
    expect(body).not.toContain('root:'); // /etc/passwd content itself
  });

  it('contains raw traversal', async () => {
    // The URL API normalises '..' away, so this has to be sent by hand —
    // which is also what a raw socket attacker would do.
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(new URL(base).port), path: '/../../etc/passwd', method: 'GET' },
        (res) => { res.on('data', (d) => resolve(d.toString())); }
      );
      req.on('error', reject);
      req.end();
    });
    expect(body).toContain('pos-shell');
    expect(body).not.toContain('root:');
  });
});
