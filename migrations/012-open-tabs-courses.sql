-- Migration 012: Open tabs — course column on order_items
--
-- Each line gets a course tag (e.g. 'starters', 'mains', 'desserts') so the
-- kitchen can fire courses sequentially rather than everything at once.
-- DEFAULT 'main' ensures pre-migration rows stay meaningful single-course tickets.

ALTER TABLE order_items ADD COLUMN course TEXT DEFAULT 'main';
