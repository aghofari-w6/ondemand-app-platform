-- Up Migration
-- Milestone B (phase 2): Data studio, custom entities, link index, Integration Hub,
-- public API credentials. Expand-only: new tables, new nullable/defaulted columns.

-- ---------------------------------------------------------------------------
-- Data studio: versioned metadata (draft -> published -> superseded)
-- ---------------------------------------------------------------------------
CREATE TABLE metadata_version (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'discarded')),
  definition jsonb NOT NULL,
  based_on integer,
  note text NOT NULL DEFAULT '',
  impact jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by text,
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, number)
);
SELECT aod_enable_tenant_rls('metadata_version');
CREATE UNIQUE INDEX metadata_version_one_draft ON metadata_version (tenant_id) WHERE status = 'draft';
CREATE UNIQUE INDEX metadata_version_one_published ON metadata_version (tenant_id) WHERE status = 'published';

-- Runtime projections of the published version
ALTER TABLE field_definition
  ADD COLUMN pii boolean NOT NULL DEFAULT false,
  ADD COLUMN indexed boolean NOT NULL DEFAULT false,
  ADD COLUMN default_value jsonb,
  ADD COLUMN metadata_number integer;

CREATE TABLE field_access_rule (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- preset name or custom_role id
  role text NOT NULL,
  -- Cedar-style resource type, e.g. ordering::Order or custom::Supplier
  resource text NOT NULL,
  field text NOT NULL,
  access text NOT NULL CHECK (access IN ('hidden', 'read', 'write')),
  PRIMARY KEY (tenant_id, role, resource, field)
);
SELECT aod_enable_tenant_rls('field_access_rule');

-- Background work started by a publish
CREATE TABLE backfill_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  metadata_number integer NOT NULL,
  target text NOT NULL,
  field text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('encrypt', 'decrypt', 'set_default')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  processed integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
SELECT aod_enable_tenant_rls('backfill_run');

CREATE TABLE index_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  op text NOT NULL CHECK (op IN ('create', 'drop')),
  target text NOT NULL,
  field text NOT NULL,
  index_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'ready', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
SELECT aod_enable_tenant_rls('index_request');

-- ---------------------------------------------------------------------------
-- Custom entities: one generic record table, data shaped by the published metadata
-- ---------------------------------------------------------------------------
CREATE TABLE custom_record (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  entity text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  search tsvector GENERATED ALWAYS AS (jsonb_to_tsvector('simple'::regconfig, data, '["string", "numeric"]')) STORED
);
SELECT aod_enable_tenant_rls('custom_record');
CREATE INDEX custom_record_list ON custom_record (tenant_id, entity, created_at DESC, id);
CREATE INDEX custom_record_search ON custom_record USING gin (search);

-- ---------------------------------------------------------------------------
-- Link index: relations between records of different apps (no cross-app FKs)
-- ---------------------------------------------------------------------------
CREATE TABLE record_link (
  tenant_id uuid NOT NULL,
  from_type text NOT NULL,
  from_id text NOT NULL,
  rel text NOT NULL,
  to_type text NOT NULL,
  to_id text NOT NULL,
  source_event uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, from_type, from_id, rel, to_type, to_id)
);
SELECT aod_enable_tenant_rls('record_link');
CREATE INDEX record_link_to ON record_link (tenant_id, to_type, to_id);

-- ---------------------------------------------------------------------------
-- Integration Hub
-- ---------------------------------------------------------------------------
CREATE TABLE hub_connector (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  spec jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('hub_connector');

CREATE TABLE hub_endpoint (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('webhook', 'rest_push', 'kafka', 'redis_stream', 'sftp', 'sqs', 'custom')),
  config jsonb NOT NULL,
  -- write-only, AES-256-GCM via the Vault port
  credentials_enc text,
  signing_secret_enc text,
  connector_id uuid REFERENCES hub_connector(id),
  event_types text[] NOT NULL,
  filter text,
  -- event type -> pinned schema version
  schema_pins jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  circuit_state text NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  circuit_opened_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('hub_endpoint');

CREATE TABLE hub_delivery (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES hub_endpoint(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'succeeded', 'dead', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_status integer,
  last_error text,
  replays integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
SELECT aod_enable_tenant_rls('hub_delivery');
CREATE INDEX hub_delivery_due ON hub_delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX hub_delivery_endpoint ON hub_delivery (tenant_id, endpoint_id, created_at DESC);

CREATE TABLE hub_delivery_attempt (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL REFERENCES hub_delivery(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  status_code integer,
  error text,
  duration_ms integer NOT NULL
);
SELECT aod_enable_tenant_rls('hub_delivery_attempt');
CREATE INDEX hub_delivery_attempt_delivery ON hub_delivery_attempt (delivery_id, attempt);

-- Two-way sync of custom records with an external system
CREATE TABLE hub_sync (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  entity text NOT NULL,
  endpoint_id uuid REFERENCES hub_endpoint(id) ON DELETE SET NULL,
  conflict_rule text NOT NULL CHECK (conflict_rule IN ('platform_wins', 'remote_wins', 'last_write_wins')),
  field_map jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('hub_sync');

CREATE TABLE external_id_map (
  tenant_id uuid NOT NULL,
  sync_id uuid NOT NULL REFERENCES hub_sync(id) ON DELETE CASCADE,
  local_id uuid NOT NULL,
  external_id text NOT NULL,
  local_version integer NOT NULL,
  remote_updated_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_id, local_id),
  UNIQUE (sync_id, external_id)
);
SELECT aod_enable_tenant_rls('external_id_map');

-- ---------------------------------------------------------------------------
-- Public API credentials (only hashes are stored)
-- ---------------------------------------------------------------------------
CREATE TABLE api_key (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  hint text NOT NULL,
  scopes text[] NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
SELECT aod_enable_tenant_rls('api_key');

CREATE TABLE oauth_client (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  secret_hash text NOT NULL,
  scopes text[] NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
SELECT aod_enable_tenant_rls('oauth_client');

-- OAuth access tokens (client credentials) and delegated user tokens
CREATE TABLE access_token (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('oauth', 'delegated')),
  token_hash text NOT NULL UNIQUE,
  client_id uuid REFERENCES oauth_client(id) ON DELETE CASCADE,
  -- delegated tokens act for this user, never beyond the user's own permissions
  user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
  name text,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
SELECT aod_enable_tenant_rls('access_token');

-- Integration Hub delivery worker: claims due deliveries across tenants (lease).
CREATE FUNCTION hub_claim_deliveries(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT d.id FROM hub_delivery d
    WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
       OR (d.status = 'delivering' AND d.lease_until < now())
    ORDER BY d.next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE hub_delivery d SET status = 'delivering', lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  FROM due WHERE d.id = due.id
  RETURNING d.tenant_id, d.id
$$;

-- Index builder: pending index requests across tenants.
CREATE FUNCTION index_requests_pending(p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id, r.id FROM index_request r WHERE r.status = 'pending' ORDER BY r.created_at LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION hub_claim_deliveries(integer, integer), index_requests_pending(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_claim_deliveries(integer, integer), index_requests_pending(integer) TO aod_app;

-- Down Migration
DROP FUNCTION IF EXISTS index_requests_pending(integer), hub_claim_deliveries(integer, integer);
DROP TABLE IF EXISTS access_token, oauth_client, api_key, external_id_map, hub_sync, hub_delivery_attempt,
  hub_delivery, hub_endpoint, hub_connector, record_link, custom_record, index_request, backfill_run,
  field_access_rule, metadata_version;
ALTER TABLE field_definition DROP COLUMN IF EXISTS metadata_number, DROP COLUMN IF EXISTS default_value,
  DROP COLUMN IF EXISTS indexed, DROP COLUMN IF EXISTS pii;
