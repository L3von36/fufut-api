-- 019-waste-category.sql
-- The waste screen has always collected an item name and a category for
-- untracked (free-text) waste, but the waste table has nowhere to put either:
-- the generic resource handler dropped them on insert, so a logged entry
-- carried a reason and a date and nothing else. `name` holds the free-text
-- item name; `category` holds the breakdown the summary cards group by.
-- Tracked entries (an inventory link) keep using item_id/inventory_id and
-- resolve their name from the join at read time.
ALTER TABLE waste ADD COLUMN name TEXT;
ALTER TABLE waste ADD COLUMN category TEXT;
