-- Imprimatur — database schema
-- Postgres 15+ (Neon compatible). Requires pgvector; full-text via tsvector (no extra extension).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Identity
-- ============================================================
-- better-auth's expected tables (pg), then our profile columns on top.

CREATE TABLE IF NOT EXISTS organization (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user" (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image         text,
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  id         text PRIMARY KEY,
  expires_at timestamp NOT NULL,
  token      text NOT NULL UNIQUE,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  id                       text PRIMARY KEY,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamp,
  refresh_token_expires_at timestamp,
  scope                    text,
  password                 text,
  created_at               timestamp NOT NULL DEFAULT now(),
  updated_at               timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "verification" (
  id         text PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS org_id       uuid REFERENCES organization(id) ON DELETE SET NULL,
                   ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'creator'
                     CHECK (role IN ('creator', 'reviewer', 'admin')),
                   ADD COLUMN IF NOT EXISTS display_name text;

-- ============================================================
-- Brand knowledge
-- ============================================================
-- Versioned facts: every edit is a NEW row with a higher version and an
-- effective range. Old rows stay (expired, not deleted) so past findings
-- remain explainable and affected approvals can be flagged for re-review.

CREATE TABLE IF NOT EXISTS fact (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- stable identity across versions: same fact_key = same fact, new version
  fact_key       text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  statement      text NOT NULL,                    -- canonical approved wording
  source_title   text,
  source_url     text,
  source_quote   text,                              -- verbatim supporting quote
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,                       -- NULL = currently in force
  superseded_by  uuid REFERENCES fact(id),
  created_by     text REFERENCES "user"(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  embedding      vector(768),
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED,
  UNIQUE (org_id, fact_key, version)
);
CREATE INDEX IF NOT EXISTS fact_active_idx  ON fact (org_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS fact_tsv_idx     ON fact USING gin (tsv);
CREATE INDEX IF NOT EXISTS fact_vec_idx     ON fact USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS guideline (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('terminology', 'tone', 'banned_phrase', 'style_rule')),
  -- terminology rows: must_use / must_avoid pair for the same concept
  must_use   text,
  must_avoid text,
  note       text,
  severity   text NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warn')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'terminology' OR (must_use IS NOT NULL AND must_avoid IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS guideline_org_idx ON guideline (org_id, active);

-- ============================================================
-- Drafts and reviews
-- ============================================================
CREATE TABLE IF NOT EXISTS draft (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'Untitled draft',
  content       text NOT NULL,                       -- sanitized HTML or markdown
  content_plain text NOT NULL,                       -- normalized plain text for matching
  draft_sha256  text NOT NULL,                       -- fingerprint of content_plain at last review
  created_by    text NOT NULL REFERENCES "user"(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS draft_org_idx ON draft (org_id);

-- One review run per (draft, content hash). Editing the draft changes the
-- hash, which makes every prior approval stale by definition — the workflow
-- layer refuses to act on approvals whose draft_sha256 no longer matches.
CREATE TABLE IF NOT EXISTS review_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id     uuid NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  draft_sha256 text NOT NULL,
  lane         text NOT NULL CHECK (lane IN ('deterministic', 'full')),
  started_by   text REFERENCES "user"(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  integer
);

CREATE TABLE IF NOT EXISTS finding (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES review_run(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- six-state epistemic schema (claims), plus the human-review routing
  -- outcome and the deterministic accessibility category (advisory, Round 3)
  state         text NOT NULL CHECK (state IN (
                   'contradicts_fact', 'unsupported', 'unverifiable',
                   'sources_conflict', 'promotional_puffery', 'compliant',
                   'human_review', 'accessibility_issue')),
  -- where in the draft (plain-text character offsets against content_plain)
  start_offset  integer NOT NULL,
  end_offset    integer NOT NULL,
  excerpt       text NOT NULL,
  explanation   text NOT NULL,                       -- human-readable, shown on the card
  -- evidence chain (nullable: deterministic lane findings carry rule ids instead)
  fact_id       uuid REFERENCES fact(id),
  gate_detail   jsonb,                               -- per-gate outcomes for audit display
  rule_ref      text,                                -- e.g. 'terminology:meridian-flow/ai assistant'
  resolved      boolean NOT NULL DEFAULT false,      -- creator addressed it in a newer run
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finding_run_idx ON finding (run_id);

CREATE TABLE IF NOT EXISTS approval (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id     uuid NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  draft_sha256 text NOT NULL,                        -- binds approval to exact content
  decided_by   text NOT NULL REFERENCES "user"(id),
  decision     text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  rationale    text,
  decided_at   timestamptz NOT NULL DEFAULT now(),
  -- approvals are revoked, never edited: revocation is a new row
  revoked_at   timestamptz,
  revoked_reason text
);
CREATE INDEX IF NOT EXISTS approval_draft_idx ON approval (draft_id) WHERE revoked_at IS NULL;

-- ============================================================
-- Audit log — append-only, hash-chained
-- ============================================================
-- The chain: row_hash = sha256(prev_hash || canonical_json(payload) || occurred_at).
-- A trigger computes it on INSERT; a second trigger makes UPDATE and DELETE
-- fail outright. Tampering with any historical row breaks every later hash.

CREATE TABLE IF NOT EXISTS audit_log (
  seq         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text REFERENCES "user"(id),
  org_id      uuid REFERENCES organization(id) ON DELETE SET NULL,
  action      text NOT NULL,                         -- e.g. 'review.run', 'approval.grant'
  payload     jsonb NOT NULL,
  prev_hash   text NOT NULL,
  row_hash    text NOT NULL
);

CREATE OR REPLACE FUNCTION audit_chain_insert() RETURNS trigger AS $$
DECLARE
  last_hash text;
BEGIN
  -- serialize appends: two concurrent inserts must not chain off the same row
  PERFORM pg_advisory_xact_lock(4211871);
  SELECT row_hash INTO last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  IF last_hash IS NULL THEN last_hash := 'GENESIS'; END IF;
  NEW.prev_hash := last_hash;
  NEW.row_hash  := encode(digest(
    last_hash || '|' || coalesce(NEW.actor::text, '') || '|' ||
    NEW.action || '|' || NEW.occurred_at::text || '|' ||
    convert_to(NEW.payload::text, 'UTF8'),
    'sha256'), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_block_write() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % blocked on seq %', TG_OP, OLD.seq;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_insert_chain ON audit_log;
CREATE TRIGGER audit_insert_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_chain_insert();
DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_block_write();

-- Verify the chain INSIDE the database, recomputing each hash with the
-- trigger's own expressions, so verification can never disagree with how
-- the hashes were produced (the application-side verifier exists for
-- offline chains and tests; production reads this function).
CREATE OR REPLACE FUNCTION audit_verify_chain() RETURNS TABLE (ok boolean, first_bad bigint, reason text) AS $$
DECLARE
  prev text := 'GENESIS';
  r record;
  expect text;
BEGIN
  FOR r IN SELECT seq, actor, action, occurred_at, payload, prev_hash, row_hash FROM audit_log ORDER BY seq LOOP
    IF r.prev_hash <> prev THEN
      RETURN QUERY SELECT false, r.seq, 'prev_hash mismatch at seq ' || r.seq;
      RETURN;
    END IF;
    expect := encode(digest(
      prev || '|' || coalesce(r.actor::text, '') || '|' ||
      r.action || '|' || r.occurred_at::text || '|' ||
      convert_to(r.payload::text, 'UTF8'),
      'sha256'), 'hex');
    IF expect <> r.row_hash THEN
      RETURN QUERY SELECT false, r.seq, 'row_hash mismatch at seq ' || r.seq;
      RETURN;
    END IF;
    prev := r.row_hash;
  END LOOP;
  RETURN QUERY SELECT true, NULL::bigint, NULL::text;
END $$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- Retrieval — hybrid keyword + vector, fused with RRF
-- ============================================================
-- k: candidate pool per lane; rrf_k: the standard damping constant (60 in the
-- literature; we use 50 as tuned in the plan). Query embeddings are computed
-- in application code (the model call is ours to control and disclose).

CREATE OR REPLACE FUNCTION search_facts_hybrid(
  p_org       uuid,
  p_query     text,
  p_embedding vector(768),
  p_k         integer DEFAULT 20,
  p_rrf_k     integer DEFAULT 50
) RETURNS TABLE (
  fact_id    uuid,
  fact_key   text,
  statement  text,
  source_title text,
  source_url text,
  source_quote text,
  rrf_score  real,
  text_rank  real,
  vec_rank   real
) AS $$
  WITH text_lane AS (
    SELECT f.id, f.fact_key, f.statement, f.source_title, f.source_url, f.source_quote,
           ts_rank(f.tsv, websearch_to_tsquery('english', p_query)) AS score
    FROM fact f
    WHERE f.org_id = p_org AND f.effective_to IS NULL
      AND f.tsv @@ websearch_to_tsquery('english', p_query)
    ORDER BY score DESC LIMIT p_k
  ),
  vec_lane AS (
    SELECT f.id, f.fact_key, f.statement, f.source_title, f.source_url, f.source_quote,
           1 - (f.embedding <=> p_embedding) AS score
    FROM fact f
    WHERE f.org_id = p_org AND f.effective_to IS NULL
      AND f.embedding IS NOT NULL
    ORDER BY f.embedding <=> p_embedding LIMIT p_k
  ),
  text_ranked AS (
    SELECT id, fact_key, statement, source_title, source_url, source_quote,
           row_number() OVER (ORDER BY score DESC) AS rnk, score FROM text_lane
  ),
  vec_ranked AS (
    SELECT id, fact_key, statement, source_title, source_url, source_quote,
           row_number() OVER (ORDER BY score DESC) AS rnk, score FROM vec_lane
  )
  SELECT t.id, t.fact_key, t.statement, t.source_title, t.source_url, t.source_quote,
         (1.0/(p_rrf_k + t.rnk) + 1.0/(p_rrf_k + v.rnk))::real AS rrf_score,
         t.score::real, v.score::real
  FROM text_ranked t
  JOIN vec_ranked  v USING (id)
  UNION ALL
  SELECT t.id, t.fact_key, t.statement, t.source_title, t.source_url, t.source_quote,
         (1.0/(p_rrf_k + t.rnk))::real, t.score::real, NULL::real
  FROM text_ranked t WHERE t.id NOT IN (SELECT id FROM vec_ranked)
  UNION ALL
  SELECT v.id, v.fact_key, v.statement, v.source_title, v.source_url, v.source_quote,
         (1.0/(p_rrf_k + v.rnk))::real, NULL::real, v.score::real
  FROM vec_ranked v WHERE v.id NOT IN (SELECT id FROM text_ranked)
  ORDER BY rrf_score DESC LIMIT p_k;
$$ LANGUAGE sql STABLE;

-- ============================================================
-- Re-review triggers: knowledge changed => stale approvals get flagged
-- ============================================================
CREATE TABLE IF NOT EXISTS re_review_flag (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      uuid NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  reason        text NOT NULL,                       -- 'fact_expired', 'fact_edited', 'guideline_edited'
  ref_id        text,                                -- fact_key or guideline id
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE OR REPLACE FUNCTION flag_on_fact_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.effective_to IS NOT NULL AND OLD.effective_to IS NULL THEN
    INSERT INTO re_review_flag (draft_id, reason, ref_id)
    SELECT d.id, 'fact_expired', NEW.fact_key
    FROM draft d
    JOIN approval a ON a.draft_id = d.id AND a.revoked_at IS NULL AND a.decision = 'approved';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fact_change_flags ON fact;
CREATE TRIGGER fact_change_flags AFTER UPDATE ON fact
  FOR EACH ROW EXECUTE FUNCTION flag_on_fact_change();
