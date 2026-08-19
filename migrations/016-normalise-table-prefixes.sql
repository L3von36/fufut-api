-- 016 — one spelling for a table reference, including the prefixed ones.
--
--   npx wrangler d1 execute fufut-db --remote --file=migrations/016-normalise-table-prefixes.sql
--
-- Migration 013 collapsed "7.0" and "03" onto "7" and "3", but only for the
-- three exact values that existed that day. It did not cover the prefixed
-- spellings, because at the time nothing wrote them.
--
-- The QR ordering path does. It filed an order under the raw `tables.id`,
-- which is free text and reads "T6" in the seeded rows and "Table 6" in the
-- live ones, while the POS files the same table under "6". Every screen
-- compares table_id as a string, so those orders belonged to no table: a
-- guest ordered from the card on the table and the waiter's floor plan showed
-- nothing against it.
--
-- The write path is fixed in lib/staleness.js; this is the backlog.
--
-- Each statement rewrites one spelling onto the bare number the rest of the
-- system already uses, and only when what remains is unambiguously digits. A
-- table genuinely labelled "A1", "Patio 2", "Table A" or bare "T" keeps
-- exactly what it has — those are names, and merging them would merge two
-- real tables into one.

-- "Table 6", "table_6", "Table-4", "TBL 12"  ->  "6", "6", "4", "12"
UPDATE orders
   SET table_id = CAST(CAST(
         REPLACE(REPLACE(REPLACE(REPLACE(
           REPLACE(LOWER(TRIM(table_id)), 'table', ''), 'tbl', ''),
         ' ', ''), '_', ''), '-', '') AS INTEGER) AS TEXT)
 WHERE table_id IS NOT NULL
   AND (LOWER(TRIM(table_id)) GLOB 'table*' OR LOWER(TRIM(table_id)) GLOB 'tbl*')
   AND REPLACE(REPLACE(REPLACE(REPLACE(
         REPLACE(LOWER(TRIM(table_id)), 'table', ''), 'tbl', ''),
       ' ', ''), '_', ''), '-', '') GLOB '[0-9]*'
   AND REPLACE(REPLACE(REPLACE(REPLACE(
         REPLACE(LOWER(TRIM(table_id)), 'table', ''), 'tbl', ''),
       ' ', ''), '_', ''), '-', '') NOT GLOB '*[^0-9]*';

-- "T6", "t-7"  ->  "6", "7". The all-digits guard on the remainder is what
-- keeps "Patio 2" and a bare "T" out of it.
UPDATE orders
   SET table_id = CAST(CAST(
         REPLACE(REPLACE(REPLACE(SUBSTR(TRIM(table_id), 2),
         ' ', ''), '_', ''), '-', '') AS INTEGER) AS TEXT)
 WHERE table_id IS NOT NULL
   AND LOWER(SUBSTR(TRIM(table_id), 1, 1)) = 't'
   AND LENGTH(TRIM(table_id)) > 1
   AND REPLACE(REPLACE(REPLACE(SUBSTR(TRIM(table_id), 2),
       ' ', ''), '_', ''), '-', '') GLOB '[0-9]*'
   AND REPLACE(REPLACE(REPLACE(SUBSTR(TRIM(table_id), 2),
       ' ', ''), '_', ''), '-', '') NOT GLOB '*[^0-9]*';

-- "7.0", "2.00"  ->  "7", "2". Generalises the three hand-listed rows in 013.
-- "2.5" is not a whole number, so it is not ours to reinterpret.
UPDATE orders
   SET table_id = CAST(CAST(TRIM(table_id) AS INTEGER) AS TEXT)
 WHERE table_id IS NOT NULL
   AND TRIM(table_id) GLOB '[0-9]*.[0]*'
   AND TRIM(table_id) NOT GLOB '*[^0-9.]*'
   AND CAST(TRIM(table_id) AS REAL) = CAST(CAST(TRIM(table_id) AS INTEGER) AS REAL);

-- "03", " 7 "  ->  "3", "7". Leading zeros and stray whitespace.
UPDATE orders
   SET table_id = CAST(CAST(TRIM(table_id) AS INTEGER) AS TEXT)
 WHERE table_id IS NOT NULL
   AND TRIM(table_id) <> ''
   AND TRIM(table_id) NOT GLOB '*[^0-9]*'
   -- Compared untrimmed, so " 7 " is caught as well as "03".
   AND table_id <> CAST(CAST(TRIM(table_id) AS INTEGER) AS TEXT);
