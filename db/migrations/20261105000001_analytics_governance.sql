-- Up Migration
-- Milestone D (phase 4): analytics (metrics, dashboards, reports), files, data governance.
-- Expand-only.

-- ---------------------------------------------------------------------------
-- Metrics: per-tenant hourly buckets (ClickHouse later, behind the Analytics port)
-- ---------------------------------------------------------------------------
CREATE TABLE metric_bucket (
  tenant_id uuid NOT NULL,
  -- `<app>:<metric>` or `custom:<metric>`
  metric text NOT NULL,
  bucket timestamptz NOT NULL,
  store text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT '',
  value numeric NOT NULL DEFAULT 0,
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, metric, bucket, store, channel)
);
SELECT aod_enable_tenant_rls('metric_bucket');

-- Which definition each metric's buckets were built from, and rebuild progress.
CREATE TABLE metric_state (
  tenant_id uuid NOT NULL,
  metric text NOT NULL,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('rebuilding', 'ready')),
  -- events up to this event_log seq are covered by the rebuild; later ones by the consumer
  through_seq bigint NOT NULL DEFAULT 0,
  cursor_seq bigint NOT NULL DEFAULT 0,
  rebuilt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric)
);
SELECT aod_enable_tenant_rls('metric_state');

-- Nightly reconciliation results (buckets vs the source tables).
CREATE TABLE metric_check (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  metric text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  bucket_value numeric NOT NULL,
  source_value numeric NOT NULL,
  ok boolean NOT NULL,
  action text NOT NULL DEFAULT 'none' CHECK (action IN ('none', 'rebuild', 'drift_persists'))
);
SELECT aod_enable_tenant_rls('metric_check');
CREATE INDEX metric_check_recent ON metric_check (tenant_id, metric, checked_at DESC);

-- ---------------------------------------------------------------------------
-- Dashboards and reports
-- ---------------------------------------------------------------------------
CREATE TABLE dashboard (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  widgets jsonb NOT NULL DEFAULT '[]',
  shared_roles text[] NOT NULL DEFAULT '{}',
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('dashboard');

CREATE TABLE report (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- { metrics, range, granularity, group_by, filters }
  query jsonb NOT NULL,
  -- { every: day|week|month, hour, weekday?, format: csv|pdf, deliver: file|email } or null
  schedule jsonb,
  next_run_at timestamptz,
  schedule_claimed_until timestamptz,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('report');
CREATE INDEX report_due ON report (next_run_at) WHERE next_run_at IS NOT NULL;

CREATE TABLE report_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  report_id uuid NOT NULL REFERENCES report(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  format text NOT NULL CHECK (format IN ('csv', 'pdf')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  file_id uuid,
  rows integer,
  delivery text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
SELECT aod_enable_tenant_rls('report_run');
CREATE INDEX report_run_list ON report_run (tenant_id, report_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Files (S3 later, behind the Files port): chunked bytea under RLS, streamed both ways
-- ---------------------------------------------------------------------------
CREATE TABLE file_object (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL DEFAULT 0,
  sha256 text,
  status text NOT NULL CHECK (status IN ('writing', 'ready', 'failed')),
  -- what created it, e.g. `report:<id>`, `dsr:<id>`, `audit-export`
  purpose text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
SELECT aod_enable_tenant_rls('file_object');
CREATE INDEX file_object_expiry ON file_object (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE file_chunk (
  tenant_id uuid NOT NULL,
  file_id uuid NOT NULL REFERENCES file_object(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (file_id, seq)
);
SELECT aod_enable_tenant_rls('file_chunk');

-- ---------------------------------------------------------------------------
-- Data governance
-- ---------------------------------------------------------------------------
CREATE TABLE retention_policy (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  -- `<app>:<entity>` or `custom:<entity>`
  target text NOT NULL,
  action text NOT NULL CHECK (action IN ('anonymise', 'purge')),
  after_days integer NOT NULL CHECK (after_days BETWEEN 1 AND 3650),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_result jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, target)
);
SELECT aod_enable_tenant_rls('retention_policy');

CREATE TABLE dsr_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('export', 'erase')),
  -- the subject's email / phone, encrypted (Vault); never stored in clear
  subject_enc text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  -- what was found: [{ resource, id, fields }] (no values)
  found jsonb NOT NULL DEFAULT '[]',
  file_id uuid,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);
SELECT aod_enable_tenant_rls('dsr_request');

-- ---------------------------------------------------------------------------
-- Cross-tenant schedulers (narrow, owner-defined, granted to aod_app only)
-- ---------------------------------------------------------------------------

-- Claims due report schedules across tenants (lease of p_lease_seconds).
CREATE FUNCTION report_claim_due(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT r.id FROM report r
    WHERE r.next_run_at <= now() AND (r.schedule_claimed_until IS NULL OR r.schedule_claimed_until < now())
    ORDER BY r.next_run_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE report r SET schedule_claimed_until = now() + make_interval(secs => p_lease_seconds)
  FROM due WHERE r.id = due.id
  RETURNING r.tenant_id, r.id
$$;
REVOKE ALL ON FUNCTION report_claim_due(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_claim_due(integer, integer) TO aod_app;

-- Tenants that have metrics (nightly reconciliation) — ids only.
CREATE FUNCTION metric_tenants() RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT s.tenant_id FROM metric_state s JOIN tenant t ON t.id = s.tenant_id WHERE t.status IN ('trial', 'active')
$$;
REVOKE ALL ON FUNCTION metric_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION metric_tenants() TO aod_app;

-- Tenants with enabled retention policies (nightly retention) — ids only.
CREATE FUNCTION retention_tenants() RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT r.tenant_id FROM retention_policy r JOIN tenant t ON t.id = r.tenant_id WHERE r.enabled AND t.status IN ('trial', 'active')
$$;
REVOKE ALL ON FUNCTION retention_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_tenants() TO aod_app;

-- Deletes expired files across tenants (nightly); returns how many.
CREATE FUNCTION delete_expired_files() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (DELETE FROM file_object WHERE expires_at < now() RETURNING 1) SELECT count(*)::int FROM gone
$$;
REVOKE ALL ON FUNCTION delete_expired_files() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_expired_files() TO aod_app;

-- Down Migration
DROP FUNCTION IF EXISTS delete_expired_files();
DROP FUNCTION IF EXISTS retention_tenants();
DROP FUNCTION IF EXISTS metric_tenants();
DROP FUNCTION IF EXISTS report_claim_due(integer, integer);
DROP TABLE IF EXISTS dsr_request, retention_policy, file_chunk, file_object, report_run, report, dashboard, metric_check, metric_state, metric_bucket;
