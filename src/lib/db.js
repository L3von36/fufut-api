import { outboxCapture, outboxBatchStatements } from './outbox.js';
import { countRowsRead } from './quota.js';

var D1_BINDING = "DB";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

function vid() {
  return "v" + crypto.randomUUID().slice(0, 8);
}

async function d1Query(env, sql, params = []) {
  const res = await env[D1_BINDING].prepare(sql).bind(...params).all();
  // meta.rows_read is the same counter Cloudflare bills the daily budget
  // against — the quota circuit breaker (lib/quota.js) runs on exact numbers,
  // not estimates. A response without meta (some test doubles) counts zero.
  countRowsRead(res && res.meta ? res.meta.rows_read : 0);
  return res;
}

async function d1Run(env, sql, params = []) {
  const result = await env[D1_BINDING].prepare(sql).bind(...params).run();
  countRowsRead(result && result.meta ? result.meta.rows_read : 0);
  // After the write, never before: the journal describes what happened, so a
  // statement that failed must leave no entry behind for the other side to
  // replay.
  await outboxCapture(env, sql, params);
  return result;
}

/**
 * A batch, journalled inside its own transaction.
 *
 * Takes `{ sql, params }` descriptors rather than pre-bound statements,
 * because the journal needs the SQL and the parameters and a bound D1
 * statement will not give them back. The outbox inserts ride along in the same
 * batch, so on both sides the journal commits with the writes it describes or
 * not at all — an order that exists without its sync entry would reach the
 * kitchen here and never appear on the other side.
 */
async function d1Batch(env, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const statements = list.map(({ sql, params = [] }) => env[D1_BINDING].prepare(sql).bind(...params));
  if (!statements.length) return [];
  const results = await env[D1_BINDING].batch([...statements, ...outboxBatchStatements(env, list)]);
  for (const r of results) countRowsRead(r && r.meta ? r.meta.rows_read : 0);
  return results;
}

function stripMeta(content) {
  if (!content || typeof content !== "object") return content;
  const clean = {};
  for (const k of Object.keys(content)) {
    if (!k.startsWith("_")) clean[k] = content[k];
  }
  return clean;
}

/**
 * Run a non-critical promise without blocking the response.
 *
 * Cloudflare Workers extend the lifetime of a request past its response via
 * `ctx.waitUntil()` — the response is returned immediately and the deferred
 * work runs on the same isolate until it resolves or the runtime reaps it.
 *
 * This is the right home for audit writes, best-effort reservation links,
 * cash-drawer tallies and anything else whose failure must not fail the action
 * it describes. Audit's own `writeAudit` already swallows errors, but it
 * currently `await`s the INSERT on the request path, adding latency to every
 * mutating handler. Wrapping the call here instead moves it off the hot path
 * without changing failure semantics.
 *
 * If `ctx` is unavailable (e.g. a unit test invoking a handler directly),
 * the promise is still kicked off and errors are swallowed — so a handler
 * test does not need to construct a fake `ctx` to use this.
 */
function fireAndForget(ctx, promise) {
  if (!promise || typeof promise.then !== 'function') return;
  const safe = (typeof promise.catch === 'function')
    ? promise.catch((e) => console.error('[fireAndForget]', e))
    : promise;
  try {
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(safe);
    }
  } catch {
    // ctx.waitUntil is optional in some test runtimes; the promise still runs.
  }
}

export { D1_BINDING, json, readBody, now, vid, d1Query, d1Run, d1Batch, stripMeta, fireAndForget };
