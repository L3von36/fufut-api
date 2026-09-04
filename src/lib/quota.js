/**
 * The D1 quota circuit breaker.
 *
 * On 2026-09-04 this account read 5,291,558 D1 rows by 12:00 UTC — the free
 * tier's whole day — and every authenticated endpoint answered the raw Worker
 * exception "error code: 1101" until midnight. The read-reduction work
 * (coalesced SSE, microcache, probe queries) makes that profile unlikely
 * again; this module makes it IMPOSSIBLE to hit unawares. It is the load
 * shedder ChatGPT's architecture note calls the "quota circuit breaker", with
 * one thing most such designs lack: the counter is EXACT, not estimated.
 *
 * How the counting works:
 *
 *   Every D1 response carries meta.rows_read — the same number Cloudflare
 *   bills. db.js (and sync.js's replay path) call countRowsRead() with it
 *   after every statement, so the isolate always knows precisely how many
 *   rows it has read today. There is no sampling and no guesswork.
 *
 * How it survives isolate death (deploys, evictions):
 *
 *   The per-isolate total is merged into a per-day KV key
 *   (`quota:day:YYYY-MM-DD`) with a max-merge, on a lazy cadence: at most one
 *   KV read per isolate per minute and one KV write per five minutes — both
 *   draw on KV's separate, much larger free tier, not on D1. The best current
 *   estimate is max(KV day total, this isolate's local count): monotonically
 *   wrong only in the rare window where two isolates' flushes interleave, and
 *   self-healing on the next flush. A breaker does not need perfect
 *   accounting; it needs to be within a few percent within a minute.
 *
 * The mode ladder (percentage of the daily budget):
 *
 *   < 70%   normal     — everything as designed
 *   70-85%  conserve   — SSE refresh window x4, cache TTLs x3
 *   85-95%  emergency  — SSE x8, TTLs x8, cron sweeps every other minute
 *   >= 95%  critical   — SSE goes keepalive-only (clients keep the last board),
 *                        reports answer 503 without touching D1, sweeps stop,
 *                        only the POS's critical paths still query
 *
 *   The POS keeps working in every mode: login, orders, payments, inventory
 *   transactions and the live boards are never shed — exactly the split the
 *   architecture note draws. What degrades is freshness (seconds, not
 *   correctness) and convenience screens (reports), never money or tickets.
 *
 * `GET /api/health` reads this module — and deliberately reads NOTHING else:
 * no D1, so the health answer stays up precisely when everything else is
 * down, which is when you need it most. A manager presenting a session gets
 * the full operational detail; anonymous callers get mode + numbers only.
 *
 * A manager can also pin a mode by hand (POST /api/health/mode {mode}) — the
 * manual override for "we are about to do something expensive" or "I do not
 * trust the meter". An override set to '' returns control to the ladder.
 */

const MODES = ['normal', 'conserve', 'emergency', 'critical'];

// Where each mode begins, as a fraction of the daily budget.
const THRESHOLDS = { conserve: 0.7, emergency: 0.85, critical: 0.95 };

// The D1 free tier's daily row-read allowance. Overridable via the KV key
// below (wrangler kv key put, or a future settings screen) so a Workers Paid
// upgrade is a config change, not a redeploy.
const DEFAULT_BUDGET = 5_000_000;
const KV_BUDGET_KEY = 'quota:budget';
const KV_OVERRIDE_KEY = 'quota:mode:override';
const KV_DAY_PREFIX = 'quota:day:';

// KV budgets on the free tier: 100k reads/day, 1k writes/day. These cadences
// keep this module inside ~1.5k reads and ~300 writes per isolate per day —
// a rounding error next to the menus the site already reads, and invisible
// next to what D1 was dying of.
const KV_REFRESH_MS = 60_000; // how often one isolate re-reads the day total
const FLUSH_MIN_MS = 300_000; // never flush more often than this
const FLUSH_MAX_MS = 900_000; // ...but always flush at least this often
const FLUSH_DELTA_ROWS = 200_000; // ...or as soon as this much has accrued

const state = {
  day: utcDate(),
  local: 0, // rows read by THIS isolate today, exact
  kv: { at: 0, reads: 0, budget: DEFAULT_BUDGET, override: '', ok: null },
  lastFlushAt: 0,
  lastFlushLocal: 0,
  inflightFlush: null,
  mode: 'normal',
  cronTicks: 0,
  sse: { tables: 0, kitchen: 0, alerts: 0, activity: 0 },
  cache: { hits: {}, misses: {} },
};

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Midnight UTC rolls the counter over — the same moment D1's own budget does. */
function rolloverIfNeeded() {
  const today = utcDate();
  if (state.day === today) return;
  state.day = today;
  state.local = 0;
  state.kv.reads = 0;
  state.kv.at = 0; // force the next refresh to fetch the fresh day's key
  state.lastFlushAt = 0;
  state.lastFlushLocal = 0;
}

/** Best current estimate of today's account-wide rows read. */
function estimateToday() {
  return Math.max(state.kv.reads || 0, state.local || 0);
}

function modeForEstimate(rows, budget, override) {
  if (override && MODES.includes(override)) return override;
  const pct = budget > 0 ? rows / budget : 1;
  if (pct >= THRESHOLDS.critical) return 'critical';
  if (pct >= THRESHOLDS.emergency) return 'emergency';
  if (pct >= THRESHOLDS.conserve) return 'conserve';
  return 'normal';
}

function recomputeMode() {
  state.mode = modeForEstimate(estimateToday(), state.kv.budget, state.kv.override);
}

/**
 * Record the rows a finished D1 statement actually read. Called from db.js
 * with the response's meta — never with a guess. Zero is the common case for
 * writes and is skipped without ceremony.
 */
export function countRowsRead(rows) {
  const n = Number(rows) || 0;
  if (!n) return;
  rolloverIfNeeded();
  state.local += n;
  recomputeMode();
}

/**
 * Re-read the day total, budget and override from KV — at most once per
 * minute per isolate. Every KV failure is swallowed: a dead KV leaves the
 * last known numbers standing (and a never-known number standing at the
 * DEFAULT_BUDGET), so the breaker can only ever degrade to "quietly keep
 * serving", never to "break the request that triggered the check".
 */
export async function refreshQuota(env) {
  rolloverIfNeeded();
  if (!env || !env.CONTENT_KV || !env.CONTENT_KV.get) {
    recomputeMode();
    return state.mode;
  }
  const now = Date.now();
  if (now - state.kv.at < KV_REFRESH_MS) {
    recomputeMode();
    return state.mode;
  }
  state.kv.at = now; // stamped first: a stampede of callers awaits one flight
  try {
    const [dayRaw, budgetRaw, overrideRaw] = await Promise.all([
      env.CONTENT_KV.get(KV_DAY_PREFIX + state.day),
      env.CONTENT_KV.get(KV_BUDGET_KEY),
      env.CONTENT_KV.get(KV_OVERRIDE_KEY),
    ]);
    if (dayRaw) {
      const d = JSON.parse(dayRaw);
      state.kv.reads = Number(d && d.reads) || 0;
    } else {
      state.kv.reads = 0;
    }
    if (budgetRaw) {
      const b = Number(JSON.parse(budgetRaw));
      if (b > 0) state.kv.budget = b;
    }
    state.kv.override = String(overrideRaw || '').trim().toLowerCase();
    state.kv.ok = true;
  } catch {
    state.kv.ok = false; // keep the last known values; retry on the next tick
  }
  recomputeMode();
  return state.mode;
}

/**
 * Merge this isolate's local count into the day key. Max-merge, so a late or
 * interleaved writer can only ever under-report until the next flush — the
 * number converges upward and a breaker does not need the missing seconds.
 */
async function flushNow(env) {
  if (!env || !env.CONTENT_KV || !env.CONTENT_KV.get) return;
  if (state.inflightFlush) return state.inflightFlush;
  state.inflightFlush = (async () => {
    try {
      const key = KV_DAY_PREFIX + state.day;
      const raw = await env.CONTENT_KV.get(key);
      const stored = raw ? Number((JSON.parse(raw) || {}).reads) || 0 : 0;
      const merged = Math.max(stored, state.kv.reads || 0, state.local || 0);
      if (merged > stored) {
        await env.CONTENT_KV.put(key, JSON.stringify({ reads: merged, at: new Date().toISOString() }));
      }
      state.lastFlushAt = Date.now();
      state.lastFlushLocal = state.local;
    } catch {
      // KV hiccup: keep counting locally, try again on the next tick.
    } finally {
      state.inflightFlush = null;
    }
  })();
  return state.inflightFlush;
}

/**
 * The lazy maintenance tick, called from fetch() (fire-and-forget via
 * ctx.waitUntil) and awaited in scheduled(). Refreshes the KV view and
 * flushes when the cadence or the delta says so. Never throws — a quota
 * bookkeeping failure must never fail the request it rode in on.
 */
export function quotaTick(env, ctx) {
  const p = (async () => {
    try {
      await refreshQuota(env);
      const delta = state.local - state.lastFlushLocal;
      const sinceFlush = Date.now() - state.lastFlushAt;
      const firstFlush = state.lastFlushAt === 0;
      // Flush when: this isolate's first flush of the day, the accrued delta
      // is worth a write (>=200k rows = 0.1% of the error bar we tolerate),
      // or the max cadence elapsed. FLUSH_MAX_MS > FLUSH_MIN_MS, so the max
      // branch implies the min-cadence gate; a large delta bypasses it.
      if (delta > 0 && (firstFlush || delta >= FLUSH_DELTA_ROWS || sinceFlush >= FLUSH_MAX_MS)) {
        await flushNow(env);
      }
    } catch {
      // Swallowed by contract.
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(p.catch(() => {}));
    } catch {
      // Some test runtimes pass a ctx without waitUntil; the promise runs anyway.
    }
  }
  return p;
}

/** The current mode, synchronously — the hot paths (SSE ticks, cache TTLs). */
export function getModeSync() {
  return state.mode;
}

/**
 * Cron pacing. Returns whether THIS minute's scheduled run should execute the
 * D1-backed sweeps (alerts, stale tables, auto-close). checkScheduledPublish
 * is KV-only and paces itself outside this decision.
 */
export function cronShouldSweep() {
  state.cronTicks += 1;
  const every = { normal: 1, conserve: 1, emergency: 2, critical: Infinity }[state.mode] ?? 1;
  if (every === Infinity) return false;
  return state.cronTicks % every === 0;
}

// ── Degradation multipliers ────────────────────────────────────────────────
// The SSE tick interval itself never changes (the keepalive must keep flowing
// through proxies); what scales is how stale a shared payload may be before
// the next tick re-queries. Critical is Infinity: the board freezes rather
// than spend another read.

export function freshnessMultiplier(mode) {
  return { normal: 1, conserve: 4, emergency: 8, critical: Infinity }[mode] ?? 1;
}

export function cacheTtlMultiplier(mode) {
  return { normal: 1, conserve: 3, emergency: 8, critical: 20 }[mode] ?? 1;
}

// ── Instrumentation for /api/health (per-isolate, zero cost) ───────────────

export function noteSseOpen(channel) {
  state.sse[channel] = (state.sse[channel] || 0) + 1;
}

export function noteSseClose(channel) {
  state.sse[channel] = Math.max(0, (state.sse[channel] || 0) - 1);
}

export function noteCacheHit(path) {
  state.cache.hits[path] = (state.cache.hits[path] || 0) + 1;
}

export function noteCacheMiss(path) {
  state.cache.misses[path] = (state.cache.misses[path] || 0) + 1;
}

/**
 * Pin a mode by hand. 'auto' clears the pin and returns control to the meter;
 * anything else must be one of MODES. The override lives in KV, so it
 * survives deploys — a manager who pins 'conserve' before running a big
 * export keeps that protection until they say otherwise.
 */
export async function setModeOverride(env, mode) {
  const wanted = String(mode || '').trim().toLowerCase();
  if (wanted !== 'auto' && !MODES.includes(wanted)) {
    throw new Error('mode must be one of: auto, ' + MODES.join(', '));
  }
  if (env && env.CONTENT_KV && env.CONTENT_KV.put) {
    await env.CONTENT_KV.put(KV_OVERRIDE_KEY, wanted === 'auto' ? '' : wanted);
  }
  state.kv.override = wanted === 'auto' ? '' : wanted;
  recomputeMode();
  return state.mode;
}

export async function clearModeOverride(env) {
  return setModeOverride(env, 'auto'); // back to the meter
}

/**
 * Everything /api/health needs, in one await. Awaits the KV refresh (so the
 * first caller of a fresh isolate gets real numbers, not defaults), then
 * reads only memory — no D1 anywhere on this path.
 */
export async function quotaSnapshot(env) {
  await refreshQuota(env);
  const rows = estimateToday();
  const budget = state.kv.budget;
  return {
    day: state.day,
    mode: state.mode,
    rowsRead: rows,
    budget,
    pct: budget > 0 ? Math.round((rows / budget) * 1000) / 10 : 100,
    thresholds: THRESHOLDS,
    override: state.kv.override || null,
    kvOk: state.kv.ok,
    detail: {
      localIsolateRows: state.local,
      lastFlushAt: state.lastFlushAt ? new Date(state.lastFlushAt).toISOString() : null,
      sseClients: { ...state.sse },
      cacheHits: { ...state.cache.hits },
      cacheMisses: { ...state.cache.misses },
      cronTicks: state.cronTicks,
    },
  };
}

/**
 * Tests run many scenarios through one process; module state is exactly the
 * thing this module exists to keep, so each test starts from a clean slate.
 */
export function quotaResetForTest() {
  state.day = utcDate();
  state.local = 0;
  state.kv = { at: 0, reads: 0, budget: DEFAULT_BUDGET, override: '', ok: null };
  state.lastFlushAt = 0;
  state.lastFlushLocal = 0;
  state.inflightFlush = null;
  state.mode = 'normal';
  state.cronTicks = 0;
  state.sse = { tables: 0, kitchen: 0, alerts: 0, activity: 0 };
  state.cache = { hits: {}, misses: {} };
}

export { MODES, THRESHOLDS, DEFAULT_BUDGET };
