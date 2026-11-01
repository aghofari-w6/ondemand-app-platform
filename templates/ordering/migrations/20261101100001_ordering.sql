-- Up Migration
CREATE TABLE ord_counter (
  tenant_id uuid PRIMARY KEY,
  next_number integer NOT NULL
);
SELECT aod_enable_tenant_rls('ord_counter');

CREATE TABLE ord_order (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('new', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled')),
  channel text NOT NULL CHECK (channel IN ('web', 'phone', 'pos', 'marketplace')),
  store text,
  customer_name text,
  customer_phone text,
  currency text NOT NULL DEFAULT 'IDR',
  total numeric(14, 2) NOT NULL DEFAULT 0,
  notes text,
  -- where the order came from, e.g. `pos:sale:<id>`; unique so ingestion is idempotent
  source_ref text,
  custom jsonb NOT NULL DEFAULT '{}',
  placed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      number::text || ' ' || coalesce(customer_name, '') || ' ' || coalesce(store, '') || ' ' || coalesce(notes, ''))
    || jsonb_to_tsvector('simple'::regconfig, custom, '["string"]')
  ) STORED,
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, source_ref)
);
SELECT aod_enable_tenant_rls('ord_order');
CREATE INDEX ord_order_search ON ord_order USING gin (search);
CREATE INDEX ord_order_status ON ord_order (tenant_id, status, placed_at);
CREATE INDEX ord_order_placed ON ord_order (tenant_id, placed_at DESC, id);

CREATE TABLE ord_order_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES ord_order(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  qty integer NOT NULL CHECK (qty > 0),
  unit_price numeric(14, 2) NOT NULL
);
SELECT aod_enable_tenant_rls('ord_order_line');
CREATE INDEX ord_order_line_order ON ord_order_line (order_id);

-- Down Migration
DROP TABLE ord_order_line, ord_order, ord_counter;
