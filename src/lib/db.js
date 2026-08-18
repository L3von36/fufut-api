import { outboxCapture, outboxBatchStatements } from './outbox.js';

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
  return await env[D1_BINDING].prepare(sql).bind(...params).all();
}

async function d1Run(env, sql, params = []) {
  const result = await env[D1_BINDING].prepare(sql).bind(...params).run();
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
  return await env[D1_BINDING].batch([...statements, ...outboxBatchStatements(env, list)]);
}

function stripMeta(content) {
  if (!content || typeof content !== "object") return content;
  const clean = {};
  for (const k of Object.keys(content)) {
    if (!k.startsWith("_")) clean[k] = content[k];
  }
  return clean;
}
export { D1_BINDING, json, readBody, now, vid, d1Query, d1Run, d1Batch, stripMeta };
