-- Up Migration
CREATE TABLE pay_payment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('captured', 'failed', 'refunded')),
  method text NOT NULL CHECK (method IN ('card', 'qris', 'ewallet')),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL,
  provider_ref text,
  failure_reason text,
  custom jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', reference || ' ' || coalesce(provider_ref, ''))
    || jsonb_to_tsvector('simple'::regconfig, custom, '["string"]')
  ) STORED
);
SELECT aod_enable_tenant_rls('pay_payment');
CREATE INDEX pay_payment_search ON pay_payment USING gin (search);
CREATE INDEX pay_payment_created ON pay_payment (tenant_id, created_at DESC, id);

CREATE TABLE pay_settings (
  tenant_id uuid PRIMARY KEY,
  fail_next_capture boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1
);
SELECT aod_enable_tenant_rls('pay_settings');

-- Down Migration
DROP TABLE pay_settings, pay_payment;
