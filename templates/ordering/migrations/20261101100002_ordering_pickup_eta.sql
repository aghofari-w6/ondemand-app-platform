-- Up Migration
-- Release 1.1.0 (canary). Expand-only: a nullable column old code ignores.
ALTER TABLE ord_order ADD COLUMN pickup_eta timestamptz;

-- Down Migration
ALTER TABLE ord_order DROP COLUMN pickup_eta;
