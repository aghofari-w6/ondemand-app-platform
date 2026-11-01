-- Up Migration
CREATE TABLE pos_store (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('pos_store');

CREATE TABLE pos_register (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL REFERENCES pos_store(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (store_id, name)
);
SELECT aod_enable_tenant_rls('pos_register');

CREATE TABLE pos_shift (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  register_id uuid NOT NULL REFERENCES pos_register(id) ON DELETE CASCADE,
  register text NOT NULL,
  store text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  opening_float numeric(14, 2) NOT NULL DEFAULT 0,
  expected_cash numeric(14, 2),
  counted_cash numeric(14, 2),
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  custom jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', register || ' ' || store)) STORED
);
SELECT aod_enable_tenant_rls('pos_shift');
CREATE UNIQUE INDEX pos_shift_one_open ON pos_shift (register_id) WHERE status = 'open';
CREATE INDEX pos_shift_search ON pos_shift USING gin (search);

CREATE TABLE pos_sale (
  -- generated on the device so an offline sale keeps its identity through sync
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  receipt_no text NOT NULL,
  register_id uuid NOT NULL REFERENCES pos_register(id),
  shift_id uuid REFERENCES pos_shift(id),
  store text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'voided')),
  tender text NOT NULL CHECK (tender IN ('cash', 'card', 'qris')),
  currency text NOT NULL,
  total numeric(14, 2) NOT NULL,
  tendered numeric(14, 2),
  change_due numeric(14, 2),
  offline boolean NOT NULL DEFAULT false,
  -- original sale time on the device, not the sync time
  sold_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  void_reason text,
  custom jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', receipt_no || ' ' || store)
    || jsonb_to_tsvector('simple'::regconfig, custom, '["string"]')
  ) STORED,
  UNIQUE (tenant_id, receipt_no)
);
SELECT aod_enable_tenant_rls('pos_sale');
CREATE INDEX pos_sale_search ON pos_sale USING gin (search);
CREATE INDEX pos_sale_sold ON pos_sale (tenant_id, sold_at DESC, id);

CREATE TABLE pos_sale_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL REFERENCES pos_sale(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  qty integer NOT NULL CHECK (qty > 0),
  unit_price numeric(14, 2) NOT NULL
);
SELECT aod_enable_tenant_rls('pos_sale_line');
CREATE INDEX pos_sale_line_sale ON pos_sale_line (sale_id);

-- Down Migration
DROP TABLE pos_sale_line, pos_sale, pos_shift, pos_register, pos_store;
