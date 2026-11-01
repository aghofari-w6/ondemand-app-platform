-- Up Migration
-- Local projection of Ordering orders, built from order.* events (no FK to Ordering).
CREATE TABLE lgx_order (
  order_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  number integer NOT NULL,
  store text,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
SELECT aod_enable_tenant_rls('lgx_order');

CREATE TABLE lgx_shipment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid,
  order_number integer,
  carrier text NOT NULL,
  tracking_no text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  destination text,
  exception_reason text,
  delivered_at timestamptz,
  custom jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', tracking_no || ' ' || coalesce(order_number::text, '') || ' ' || coalesce(destination, ''))
    || jsonb_to_tsvector('simple'::regconfig, custom, '["string"]')
  ) STORED,
  UNIQUE (tenant_id, tracking_no)
);
SELECT aod_enable_tenant_rls('lgx_shipment');
CREATE INDEX lgx_shipment_search ON lgx_shipment USING gin (search);
CREATE INDEX lgx_shipment_created ON lgx_shipment (tenant_id, created_at DESC, id);

CREATE TABLE lgx_shipment_event (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  shipment_id uuid NOT NULL REFERENCES lgx_shipment(id) ON DELETE CASCADE,
  status text NOT NULL,
  source text NOT NULL,
  note text,
  occurred_at timestamptz NOT NULL
);
SELECT aod_enable_tenant_rls('lgx_shipment_event');

CREATE TABLE lgx_carrier_account (
  tenant_id uuid NOT NULL,
  carrier text NOT NULL,
  -- sha256 of the callback token; the token itself is shown once
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, carrier)
);
SELECT aod_enable_tenant_rls('lgx_carrier_account');

-- Down Migration
DROP TABLE lgx_carrier_account, lgx_shipment_event, lgx_shipment, lgx_order;
