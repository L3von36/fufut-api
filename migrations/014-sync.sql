-- Sync between the box in the cafe and the cloud.
--
-- Stages 4 and 5 of LOCAL-SERVER-DESIGN.md. Creating these tables changes
-- nothing on its own: capture is gated on SITE_ID, which is unset until sync is
-- deliberately switched on.

-- Every write, journalled for the other side. Append-only; rows are pruned by
-- age once both sides have acknowledged them, never updated.
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,   -- the table written to
  entity_id TEXT,            -- primary key of the affected row, when it can be told
  op        TEXT NOT NULL,   -- insert | update | delete
  payload   TEXT NOT NULL,   -- JSON { sql, params } — the write, verbatim
  at        TEXT NOT NULL
);

-- Replay is ordered per entity, so this is the index the sync engine reads on.
CREATE INDEX IF NOT EXISTS idx_outbox_entity_seq ON sync_outbox(entity, entity_id, seq);

-- Which journal this side is, so a rebuilt box is not mistaken for the old one.
--
-- `seq` restarts at 1 whenever the outbox is recreated — a re-imaged box, or one
-- restored from backup. Without a way to tell the journals apart the receiver
-- compares those fresh low seqs against the cursor it remembers and skips every
-- one as already applied: total, silent data loss with no error and no conflict.
-- Found by the staging rehearsal, where a second box's orders vanished against
-- a cursor left at 4.
CREATE TABLE IF NOT EXISTS sync_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  epoch      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- How far each side has been read. `direction` separates "what we have pushed"
-- from "what we have pulled": one row per peer per direction, so an interrupted
-- push cannot rewind the pull cursor. `epoch` is the sender's journal identity —
-- when it changes, the cursor is meaningless and resets to zero.
CREATE TABLE IF NOT EXISTS sync_cursors (
  site_id    TEXT NOT NULL,
  direction  TEXT NOT NULL,   -- in | out
  last_seq   INTEGER NOT NULL DEFAULT 0,
  epoch      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, direction)
);

-- Writes that could not be applied, and the ownership decision that refused
-- them. The design doc is explicit that a refused write must never be silently
-- dropped — that is the failure mode the research warns about with
-- last-write-wins — so everything the rules turn away lands here for a human.
CREATE TABLE IF NOT EXISTS sync_reconciliation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       TEXT NOT NULL,   -- which peer the entry came from
  seq           INTEGER,         -- its seq on that peer, for tracing
  entity        TEXT NOT NULL,
  entity_id     TEXT,
  op            TEXT,
  payload       TEXT,
  reason        TEXT NOT NULL,   -- why it was not applied
  winner        TEXT,            -- local | cloud
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_by   TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_open ON sync_reconciliation(resolved, created_at);

-- The box tells the cloud it is alive. The public ordering page reads this to
-- decide whether to accept an order the kitchen would never see.
CREATE TABLE IF NOT EXISTS venue_heartbeat (
  site_id   TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  detail    TEXT
);
