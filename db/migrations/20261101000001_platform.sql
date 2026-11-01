-- Up Migration

-- ---------------------------------------------------------------------------
-- Application role. The API process connects as `aod_app`: no superuser, no
-- BYPASSRLS, no DDL. Its password is set by the migrate script from
-- APP_DATABASE_URL so no secret lives in a migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aod_app') THEN
    CREATE ROLE aod_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
ALTER ROLE aod_app NOSUPERUSER NOBYPASSRLS;

CREATE EXTENSION IF NOT EXISTS citext;

GRANT USAGE ON SCHEMA public TO aod_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aod_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aod_app;

-- Tenant context. Set per transaction with `SET LOCAL app.tenant_id = '<uuid>'`.
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Turns on forced RLS with the standard tenant policy. Used by platform and
-- template migrations alike so every tenant table gets the same policy.
CREATE FUNCTION aod_enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
    tbl);
END $$;

-- ---------------------------------------------------------------------------
-- Tenants and identity
-- ---------------------------------------------------------------------------
CREATE TABLE tenant (
  id uuid PRIMARY KEY,
  slug citext NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'deleted')),
  plan text NOT NULL DEFAULT 'trial',
  trial_ends_at timestamptz,
  suspended_at timestamptz,
  deleted_at timestamptz,
  purge_after timestamptz,
  settings jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The tenant row is its own tenant: `id` plays the role of `tenant_id`.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

CREATE TABLE custom_role (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  permissions text[] NOT NULL DEFAULT '{}',
  field_rules jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('custom_role');

CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email citext NOT NULL,
  name text NOT NULL,
  -- a preset name (Owner, Admin, Manager, Staff, Viewer) or a custom_role id
  role text NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  password_hash text,
  last_login_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
SELECT aod_enable_tenant_rls('app_user');

CREATE TABLE user_session (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
SELECT aod_enable_tenant_rls('user_session');

CREATE TABLE login_token (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('magic', 'invite')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('login_token');

CREATE TABLE sso_config (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('oidc', 'saml')),
  config jsonb NOT NULL,
  -- write-only secret, AES-256-GCM ciphertext from the Vault port
  secret_enc text,
  enforce boolean NOT NULL DEFAULT false,
  last_test_at timestamptz,
  last_test_result text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('sso_config');

-- Pending OIDC/SAML sign-ins (state, nonce, PKCE verifier)
CREATE TABLE sso_attempt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL,
  state text NOT NULL,
  code_verifier text,
  nonce text,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
SELECT aod_enable_tenant_rls('sso_attempt');

-- ---------------------------------------------------------------------------
-- Audit (append-only: the app role may only INSERT and SELECT)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  correlation_id text,
  data jsonb NOT NULL DEFAULT '{}'
);
SELECT aod_enable_tenant_rls('audit_log');
CREATE INDEX audit_log_tenant_at ON audit_log (tenant_id, at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM aod_app;

-- ---------------------------------------------------------------------------
-- Outbox (Debezium outbox-router layout + tenant_id, created_at) and event log
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_event (
  id uuid PRIMARY KEY,
  aggregatetype text NOT NULL,
  aggregateid text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- relay bookkeeping (not part of the Debezium layout)
  seq bigserial NOT NULL,
  relayed_at timestamptz
);
SELECT aod_enable_tenant_rls('outbox_event');
CREATE INDEX outbox_event_pending ON outbox_event (seq) WHERE relayed_at IS NULL;

-- The event log is the prototype's "topic": a totally ordered, append-only log
-- written by exactly one relay (advisory lock) so `seq` order = commit order.
CREATE TABLE event_log (
  seq bigint PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  type text NOT NULL,
  aggregatetype text NOT NULL,
  aggregateid text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('event_log');
CREATE INDEX event_log_aggregate ON event_log (tenant_id, aggregateid, seq);

-- Per-consumer cursors (global: consumers read the whole log)
CREATE TABLE consumer_cursor (
  consumer text PRIMARY KEY,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processed_event (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
SELECT aod_enable_tenant_rls('processed_event');

-- ---------------------------------------------------------------------------
-- Idempotency keys (24 h)
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_key (
  tenant_id uuid NOT NULL,
  key text NOT NULL,
  scope text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, key)
);
SELECT aod_enable_tenant_rls('idempotency_key');

-- ---------------------------------------------------------------------------
-- Apps: installs, provisioning runs, contracts, pins, custom fields
-- ---------------------------------------------------------------------------
CREATE TABLE installed_app (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  app text NOT NULL,
  version text NOT NULL,
  channel text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'canary')),
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'failed', 'deprovisioning', 'retained', 'removed')),
  config jsonb NOT NULL DEFAULT '{}',
  retained_until timestamptz,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version_no integer NOT NULL DEFAULT 1
);
SELECT aod_enable_tenant_rls('installed_app');
CREATE UNIQUE INDEX installed_app_current ON installed_app (tenant_id, app) WHERE status <> 'removed';

CREATE TABLE app_pin (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  app text NOT NULL,
  version text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app)
);
SELECT aod_enable_tenant_rls('app_pin');

CREATE TABLE provisioning_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  app text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('provision', 'deprovision', 'upgrade')),
  target_version text NOT NULL,
  channel text NOT NULL DEFAULT 'stable',
  mode text CHECK (mode IN ('retain', 'purge')),
  status text NOT NULL CHECK (status IN ('running', 'failed', 'succeeded', 'compensating', 'compensated')),
  error text,
  created_by text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
SELECT aod_enable_tenant_rls('provisioning_run');
CREATE INDEX provisioning_run_tenant ON provisioning_run (tenant_id, created_at DESC);

CREATE TABLE provisioning_step (
  run_id uuid NOT NULL REFERENCES provisioning_run(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  step text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'compensated', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  output jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, step)
);
SELECT aod_enable_tenant_rls('provisioning_step');

CREATE TABLE contract_registration (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  app text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('event', 'command', 'permission', 'consumer')),
  name text NOT NULL,
  version text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app, kind, name)
);
SELECT aod_enable_tenant_rls('contract_registration');

CREATE TABLE field_definition (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  app text NOT NULL,
  entity text NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  type text NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'date', 'select')),
  options text[] NOT NULL DEFAULT '{}',
  required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app, entity, key)
);
SELECT aod_enable_tenant_rls('field_definition');

-- Tenant feature/demo flags (e.g. force a provisioning step to fail)
CREATE TABLE tenant_flag (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
SELECT aod_enable_tenant_rls('tenant_flag');

-- ---------------------------------------------------------------------------
-- Narrow cross-tenant entry points. These run as the owner (SECURITY DEFINER)
-- so the app role itself never needs BYPASSRLS. Each one returns only what its
-- caller needs.
-- ---------------------------------------------------------------------------

-- Sign-in: workspace slug -> tenant id
CREATE FUNCTION resolve_tenant(p_slug text) RETURNS TABLE (id uuid, status text, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT t.id, t.status, t.name FROM tenant t WHERE t.slug = p_slug::citext $$;

CREATE FUNCTION slug_available(p_slug text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT NOT EXISTS (SELECT 1 FROM tenant WHERE slug = p_slug::citext) $$;

-- Outbox relay: moves committed outbox rows into the event log in seq order.
-- The caller must hold the relay advisory lock (single writer).
CREATE FUNCTION outbox_relay(p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
  next_seq bigint;
BEGIN
  SELECT coalesce(max(seq), 0) INTO next_seq FROM event_log;
  WITH batch AS (
    SELECT o.id FROM outbox_event o
    WHERE o.relayed_at IS NULL
    ORDER BY o.seq
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), moved AS (
    UPDATE outbox_event o SET relayed_at = clock_timestamp()
    FROM batch WHERE o.id = batch.id
    RETURNING o.id, o.seq, o.tenant_id, o.type, o.aggregatetype, o.aggregateid, o.payload, o.created_at
  )
  INSERT INTO event_log (seq, id, tenant_id, type, aggregatetype, aggregateid, payload, created_at)
  SELECT next_seq + row_number() OVER (ORDER BY m.seq), m.id, m.tenant_id, m.type, m.aggregatetype, m.aggregateid, m.payload, m.created_at
  FROM moved m
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Consumers read the log across tenants; handlers then run tenant-scoped.
CREATE FUNCTION event_log_after(p_after bigint, p_limit integer)
  RETURNS TABLE (seq bigint, id uuid, tenant_id uuid, type text, payload jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT e.seq, e.id, e.tenant_id, e.type, e.payload FROM event_log e WHERE e.seq > p_after ORDER BY e.seq LIMIT p_limit $$;

-- Lifecycle sweeps for scheduled jobs
CREATE FUNCTION tenants_due(p_kind text) RETURNS TABLE (tenant_id uuid, app text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, NULL::text FROM tenant t
   WHERE p_kind = 'trial_expired' AND t.status = 'trial' AND t.trial_ends_at < now()
  UNION ALL
  SELECT t.id, NULL::text FROM tenant t
   WHERE p_kind = 'purge' AND t.status = 'deleted' AND t.purge_after < now()
  UNION ALL
  SELECT a.tenant_id, a.app FROM installed_app a
   WHERE p_kind = 'retained_app' AND a.status = 'retained' AND a.retained_until < now()
$$;

REVOKE ALL ON FUNCTION resolve_tenant(text), slug_available(text), outbox_relay(integer),
  event_log_after(bigint, integer), tenants_due(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text), slug_available(text), outbox_relay(integer),
  event_log_after(bigint, integer), tenants_due(text) TO aod_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO aod_app;

-- Down Migration
DROP FUNCTION IF EXISTS tenants_due(text), event_log_after(bigint, integer),
  outbox_relay(integer), slug_available(text), resolve_tenant(text);
DROP TABLE IF EXISTS tenant_flag, field_definition, contract_registration, provisioning_step, provisioning_run,
  app_pin, installed_app, idempotency_key, processed_event, consumer_cursor, event_log, outbox_event,
  audit_log, sso_attempt, sso_config, login_token, user_session, app_user, custom_role, tenant;
DROP FUNCTION IF EXISTS aod_enable_tenant_rls(regclass), current_tenant_id();
