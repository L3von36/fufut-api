-- 027: SSE probe acceleration for the kitchen channel.
--
-- The kitchen/orders SSE tick (handlers/sse.js) detects "did any active order
-- change" with MAX(updated_at) filtered to active statuses, instead of
-- re-reading up to 200 full rows per client every 10 seconds — the query
-- pattern that burned through the D1 free tier's daily row-read budget during
-- the 2026-09-04 lunch rush and 500'd the whole POS until midnight UTC.
--
-- SQLite answers a MAX() over a matching partial index from the index tip in
-- a handful of rows. Without this index the probe degrades to scanning the
-- active set's rows for updated_at — never worse than the old broad query,
-- and still run at most once per isolate per freshness window — so the code
-- is safe to ship before this migration applies. Applying it is what turns
-- the probe into a near-free read.
--
-- Partial (not full) index: completed/cancelled/fulfilled rows never match
-- the probe's predicate, and excluding them keeps the index tiny — it holds
-- only what is on the board right now, so it also stays cheap to maintain on
-- every order write.

CREATE INDEX IF NOT EXISTS idx_orders_active_updated
  ON orders(updated_at)
  WHERE status NOT IN ('completed', 'cancelled', 'fulfilled');
