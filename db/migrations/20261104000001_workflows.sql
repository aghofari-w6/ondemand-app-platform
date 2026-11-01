-- Up Migration
-- Milestone C (phase 3): workflows, approvals, trace viewer. Expand-only.

CREATE TABLE workflow (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled')),
  published_number integer,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('workflow');

CREATE TABLE workflow_version (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'discarded')),
  graph jsonb NOT NULL,
  -- denormalised from the trigger node for fast matching
  trigger_event text,
  based_on integer,
  -- set at publish: the role the workflow acts as (preset name or custom_role id) and
  -- its permissions capped by the publisher's; runtime uses (role now) ∩ this snapshot
  service_role text,
  service_permissions text[] NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by text,
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (workflow_id, number)
);
SELECT aod_enable_tenant_rls('workflow_version');
CREATE UNIQUE INDEX workflow_version_one_draft ON workflow_version (workflow_id) WHERE status = 'draft';
CREATE UNIQUE INDEX workflow_version_one_published ON workflow_version (workflow_id) WHERE status = 'published';
CREATE INDEX workflow_version_trigger ON workflow_version (tenant_id, trigger_event) WHERE status = 'published';

CREATE TABLE workflow_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_id uuid NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  trigger_event_id uuid NOT NULL,
  trigger jsonb NOT NULL,
  correlation_id text NOT NULL,
  hop integer NOT NULL,
  chain text[] NOT NULL,
  vars jsonb NOT NULL DEFAULT '{}',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
SELECT aod_enable_tenant_rls('workflow_run');
-- one run per workflow per triggering event: re-delivery never starts a second run
CREATE UNIQUE INDEX workflow_run_once ON workflow_run (workflow_id, trigger_event_id);
CREATE INDEX workflow_run_list ON workflow_run (tenant_id, workflow_id, started_at DESC);
CREATE INDEX workflow_run_correlation ON workflow_run (tenant_id, correlation_id);

CREATE TABLE workflow_node_run (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  -- parallel groups this execution belongs to, innermost last
  groups text[] NOT NULL DEFAULT '{}',
  input jsonb,
  output jsonb,
  port text,
  error text,
  -- node-specific state (e.g. an armed wait, the approval request id)
  state jsonb NOT NULL DEFAULT '{}',
  not_before timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claimed_from text,
  wait_event text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
SELECT aod_enable_tenant_rls('workflow_node_run');
CREATE INDEX workflow_node_run_run ON workflow_node_run (run_id, created_at);
CREATE INDEX workflow_node_run_due ON workflow_node_run (not_before) WHERE status IN ('pending', 'waiting');
CREATE INDEX workflow_node_run_waiting_event ON workflow_node_run (tenant_id, wait_event) WHERE status = 'waiting' AND wait_event IS NOT NULL;

-- Parallel branches still open per group (a group = one execution of a parallel node)
CREATE TABLE workflow_branch (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  merge_node text,
  open integer NOT NULL,
  arrivals jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, group_id)
);
SELECT aod_enable_tenant_rls('workflow_branch');

-- ---------------------------------------------------------------------------
-- Approvals: a platform service (workflows now, high-risk assistant tools later)
-- ---------------------------------------------------------------------------
CREATE TABLE approval_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('workflow', 'assistant')),
  source_ref text NOT NULL,
  title text NOT NULL,
  details text NOT NULL DEFAULT '',
  approver_roles text[] NOT NULL,
  quorum integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  correlation_id text,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, source, source_ref)
);
SELECT aod_enable_tenant_rls('approval_request');
CREATE INDEX approval_request_pending ON approval_request (tenant_id, status, created_at DESC);

CREATE TABLE approval_decision (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES approval_request(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, user_id)
);
SELECT aod_enable_tenant_rls('approval_decision');

-- ---------------------------------------------------------------------------
-- Trace viewer lookups
-- ---------------------------------------------------------------------------
CREATE INDEX event_log_correlation ON event_log (tenant_id, (payload ->> 'correlation_id'));
CREATE INDEX audit_log_correlation ON audit_log (tenant_id, correlation_id);
CREATE INDEX hub_delivery_event ON hub_delivery (tenant_id, event_id);
CREATE INDEX processed_event_event ON processed_event (tenant_id, event_id);

-- Workflow runner: claims due node executions across tenants (lease). `claimed_from`
-- tells the runner whether it picked up fresh work or a wait/approval timeout.
CREATE FUNCTION workflow_claim_nodes(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid, claimed_from text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT n.id, n.status FROM workflow_node_run n
    WHERE (n.status IN ('pending', 'waiting') AND n.not_before <= now())
       OR (n.status = 'running' AND n.lease_until < now())
    ORDER BY n.not_before
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE workflow_node_run n
     SET claimed_from = CASE WHEN due.status = 'running' THEN coalesce(n.claimed_from, 'pending') ELSE due.status END,
         status = 'running',
         lease_until = now() + make_interval(secs => p_lease_seconds)
  FROM due WHERE n.id = due.id
  RETURNING n.tenant_id, n.id, n.claimed_from
$$;
REVOKE ALL ON FUNCTION workflow_claim_nodes(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workflow_claim_nodes(integer, integer) TO aod_app;

-- Down Migration
DROP FUNCTION IF EXISTS workflow_claim_nodes(integer, integer);
DROP INDEX IF EXISTS processed_event_event, hub_delivery_event, audit_log_correlation, event_log_correlation;
DROP TABLE IF EXISTS approval_decision, approval_request, workflow_branch, workflow_node_run, workflow_run, workflow_version, workflow;
