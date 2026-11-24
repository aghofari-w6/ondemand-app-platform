-- Up Migration
-- Milestone E (phase 5): knowledge retrieval (pgvector), assistant, channels, inbox, bot flows.
-- Expand-only.

-- pgvector on the one PostgreSQL database (plan decision 3). The image / package must
-- ship the extension: pgvector/pgvector:pg17 in CI and compose, postgresql-16-pgvector locally.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Knowledge: sources and their chunks (Retriever port)
-- ---------------------------------------------------------------------------
CREATE TABLE doc_source (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('document', 'help', 'record')),
  title text NOT NULL,
  -- public sources may be quoted to customers by bots; internal ones only to staff
  public boolean NOT NULL DEFAULT false,
  -- help articles keep their text here; documents live in Files; records are referenced
  body text,
  file_id uuid REFERENCES file_object(id) ON DELETE SET NULL,
  ref_type text,
  ref_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed')),
  content_hash text,
  chunk_count integer NOT NULL DEFAULT 0,
  -- chunks still waiting for an embedding (full-text search answers meanwhile)
  unembedded integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('doc_source');
CREATE UNIQUE INDEX doc_source_ref ON doc_source (tenant_id, ref_type, ref_id) WHERE ref_type IS NOT NULL;

CREATE TABLE doc_chunk (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES doc_source(id) ON DELETE CASCADE,
  kind text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  seq integer NOT NULL,
  text text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  -- The dimension follows the embeddings model (EMBEDDINGS_DIM, default 1024 for Voyage);
  -- the server refuses to start retrieval if the two disagree. A different size needs a
  -- new migration and a re-embedding backfill.
  embedding vector(1024),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, seq)
);
SELECT aod_enable_tenant_rls('doc_chunk');
CREATE INDEX doc_chunk_tsv ON doc_chunk USING gin (tsv);
-- One shared HNSW index; queries filter by tenant and use iterative scans (pgvector >= 0.8).
CREATE INDEX doc_chunk_embedding ON doc_chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX doc_chunk_tenant ON doc_chunk (tenant_id, source_id);

-- ---------------------------------------------------------------------------
-- Assistant (staff): conversations, messages, tool calls, usage
-- ---------------------------------------------------------------------------
CREATE TABLE assistant_conversation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'New conversation',
  -- what the conversation is about, e.g. { "record": { "type": "ordering::Order", "id": … } }
  context jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting_confirm', 'waiting_approval')),
  -- lease of the turn in progress: one turn at a time per conversation
  running_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('assistant_conversation');
CREATE INDEX assistant_conversation_user ON assistant_conversation (tenant_id, user_id, updated_at DESC);

CREATE TABLE assistant_message (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES assistant_conversation(id) ON DELETE CASCADE,
  seq bigserial NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  -- provider-neutral content blocks, replayed unchanged on the next turn
  content jsonb NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]',
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('assistant_message');
CREATE INDEX assistant_message_conversation ON assistant_message (tenant_id, conversation_id, seq);

CREATE TABLE assistant_tool_call (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES assistant_conversation(id) ON DELETE CASCADE,
  -- the model's tool_use id: its result must answer exactly this call
  call_ref text NOT NULL,
  tool text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('read', 'low', 'high')),
  input jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_confirm', 'pending_approval', 'executed', 'declined', 'rejected', 'failed', 'expired')),
  approval_request_id uuid,
  result jsonb,
  error text,
  user_id uuid NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (conversation_id, call_ref)
);
SELECT aod_enable_tenant_rls('assistant_tool_call');
CREATE INDEX assistant_tool_call_correlation ON assistant_tool_call (tenant_id, correlation_id);

-- Per-tenant, per-month token usage: the assistant's limits now, usage meters in Milestone F.
CREATE TABLE assistant_usage (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  month date NOT NULL,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  embed_tokens bigint NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);
SELECT aod_enable_tenant_rls('assistant_usage');

-- ---------------------------------------------------------------------------
-- Channels: Telegram bots, Gmail mailboxes, web chat widgets
-- ---------------------------------------------------------------------------
CREATE TABLE channel_account (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('telegram', 'gmail', 'widget')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'disabled', 'needs_reconnect')),
  -- public settings only (bot username, mailbox address, allowed origins, accent, SLA minutes)
  config jsonb NOT NULL DEFAULT '{}',
  -- write-only, AES-256-GCM via the Vault port (bot token + webhook secret, refresh token, widget identity secret)
  secret_enc text,
  -- Gmail history cursor
  cursor jsonb NOT NULL DEFAULT '{}',
  next_poll_at timestamptz,
  last_inbound_at timestamptz,
  last_error text,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('channel_account');
CREATE INDEX channel_account_poll ON channel_account (next_poll_at) WHERE kind = 'gmail' AND status = 'active';

-- ---------------------------------------------------------------------------
-- Inbox: contacts, conversations, messages
-- ---------------------------------------------------------------------------
CREATE TABLE conv_contact (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text,
  -- PII: encrypted with the Vault port; lookups use the keyed hashes in conv_identity
  email_enc text,
  phone_enc text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('conv_contact');

CREATE TABLE conv_identity (
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES conv_contact(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'phone', 'telegram', 'widget_visitor', 'widget_user')),
  -- HMAC of the normalised value (Vault port); the value itself is never stored in clear
  value_hash text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, value_hash)
);
SELECT aod_enable_tenant_rls('conv_identity');
CREATE INDEX conv_identity_contact ON conv_identity (tenant_id, contact_id);

CREATE TABLE conversation (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES channel_account(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram', 'gmail', 'widget')),
  contact_id uuid NOT NULL REFERENCES conv_contact(id),
  -- channel thread: Telegram chat id, Gmail thread id, widget visitor id
  thread_key text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'open', 'pending', 'resolved')),
  assignee_id uuid,
  -- SLA: a first response is due at `sla_due_at` while the customer is waiting
  sla_due_at timestamptz,
  first_response_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  preview text NOT NULL DEFAULT '',
  unread integer NOT NULL DEFAULT 0,
  -- bot session: { flow_id, number, node, vars, asked }
  bot jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id, thread_key)
);
SELECT aod_enable_tenant_rls('conversation');
CREATE INDEX conversation_inbox ON conversation (tenant_id, status, last_message_at DESC);

CREATE TABLE conv_message (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq bigserial NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  author_type text NOT NULL CHECK (author_type IN ('customer', 'agent', 'bot', 'system')),
  author_id text,
  body text NOT NULL,
  -- the channel's own message id: makes inbound delivery idempotent
  external_id text,
  -- channel details: Gmail Message-ID / References, attachments [{ file_id, name, size }]
  meta jsonb NOT NULL DEFAULT '{}',
  -- outbound delivery (same mechanics as Hub deliveries: attempts, backoff, dead letter, retry)
  delivery text NOT NULL DEFAULT 'none' CHECK (delivery IN ('none', 'pending', 'sending', 'sent', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  delivery_error text,
  -- set once the bot has handled an inbound message (exactly-once bot turns)
  bot_handled_at timestamptz,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, external_id)
);
SELECT aod_enable_tenant_rls('conv_message');
CREATE INDEX conv_message_conversation ON conv_message (tenant_id, conversation_id, seq);
CREATE INDEX conv_message_due ON conv_message (next_attempt_at) WHERE delivery IN ('pending', 'sending');
CREATE INDEX conv_message_correlation ON conv_message (tenant_id, correlation_id);

CREATE TABLE conv_canned_reply (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, title)
);
SELECT aod_enable_tenant_rls('conv_canned_reply');

-- ---------------------------------------------------------------------------
-- Bot Studio: flows with draft / publish / rollback (the workflow pattern)
-- ---------------------------------------------------------------------------
CREATE TABLE bot_flow (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled')),
  published_number integer,
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT aod_enable_tenant_rls('bot_flow');

CREATE TABLE bot_flow_version (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  flow_id uuid NOT NULL REFERENCES bot_flow(id) ON DELETE CASCADE,
  number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded', 'discarded')),
  graph jsonb NOT NULL,
  -- channels the published version answers on
  channels text[] NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '',
  based_on integer,
  -- the flow's lookups run with this role, capped at the publisher's permissions
  service_role text,
  service_permissions text[],
  version integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  published_by text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, number)
);
SELECT aod_enable_tenant_rls('bot_flow_version');

-- What a flow did in a conversation, node by node (Trace viewer, Inbox).
CREATE TABLE bot_step (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  message_id uuid,
  flow_id uuid NOT NULL,
  number integer NOT NULL,
  node_id text NOT NULL,
  port text,
  detail jsonb NOT NULL DEFAULT '{}',
  correlation_id text,
  at timestamptz NOT NULL DEFAULT now()
);
SELECT aod_enable_tenant_rls('bot_step');
CREATE INDEX bot_step_correlation ON bot_step (tenant_id, correlation_id);

-- ---------------------------------------------------------------------------
-- Cross-tenant workers: narrow definer functions returning only (tenant_id, id)
-- ---------------------------------------------------------------------------

-- Channel sender: claims due outbound messages across tenants (lease).
CREATE FUNCTION conv_claim_outbound(p_limit integer, p_lease_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT m.id FROM conv_message m
    WHERE (m.delivery = 'pending' AND m.next_attempt_at <= now())
       OR (m.delivery = 'sending' AND m.lease_until < now())
    ORDER BY m.next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE conv_message m SET delivery = 'sending', lease_until = now() + make_interval(secs => p_lease_seconds)
  FROM due WHERE m.id = due.id
  RETURNING m.tenant_id, m.id
$$;

-- Gmail poller: claims mailboxes whose poll is due and schedules their next poll.
CREATE FUNCTION channel_claim_polls(p_limit integer, p_interval_seconds integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT a.id FROM channel_account a
    WHERE a.kind = 'gmail' AND a.status = 'active' AND (a.next_poll_at IS NULL OR a.next_poll_at <= now())
    ORDER BY a.next_poll_at NULLS FIRST
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE channel_account a SET next_poll_at = now() + make_interval(secs => p_interval_seconds)
  FROM due WHERE a.id = due.id
  RETURNING a.tenant_id, a.id
$$;

-- Knowledge indexer: sources still waiting for chunks or embeddings (backfill sweep).
CREATE FUNCTION doc_sources_pending(p_limit integer)
  RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.tenant_id, s.id FROM doc_source s
  WHERE (s.status = 'pending' OR s.unembedded > 0) AND s.attempts < 20 AND s.updated_at < now() - interval '30 seconds'
  ORDER BY s.updated_at LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION conv_claim_outbound(integer, integer), channel_claim_polls(integer, integer), doc_sources_pending(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION conv_claim_outbound(integer, integer), channel_claim_polls(integer, integer), doc_sources_pending(integer) TO aod_app;

-- Down Migration
DROP FUNCTION IF EXISTS doc_sources_pending(integer), channel_claim_polls(integer, integer), conv_claim_outbound(integer, integer);
DROP TABLE IF EXISTS bot_step, bot_flow_version, bot_flow, conv_canned_reply, conv_message, conversation, conv_identity, conv_contact,
  channel_account, assistant_usage, assistant_tool_call, assistant_message, assistant_conversation, doc_chunk, doc_source;
