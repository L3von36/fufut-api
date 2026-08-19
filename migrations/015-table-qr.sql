-- Ordering from the table by QR code. See QR-ORDERING-DESIGN.md.
--
-- Adding these columns changes nothing on its own: an order without a
-- `table_key` behaves exactly as it does today, so the existing website form
-- and every staff-entered order are untouched.

-- The secret printed on the table's card.
--
-- Not the table number. `?t=4` is forgeable by anyone who can count, from
-- anywhere in the world; this is what makes the code identify a table rather
-- than merely name one. Per-table so that a card which leaks or walks off costs
-- one reprint, not twelve.
--
-- NULL until a manager generates one, which is what keeps this migration inert.
ALTER TABLE tables ADD COLUMN qr_key TEXT;

-- Where an order came from.
--
-- 'qr' marks one a guest placed themselves. It is the flag the floor screen
-- filters on to know what needs accepting, and the kitchen board uses to know
-- what it must not start yet — a staff-entered order still goes straight
-- through, exactly as now.
--
-- NULL for everything that exists today, and for everything staff enter.
ALTER TABLE orders ADD COLUMN source TEXT;
