/**
 * Repository: every database read/write the routes need, in one place,
 * typed. The pipeline itself stays pure; this module feeds it.
 */

import { sql } from './client';
import type { BrandRules, TerminologyRule, BannedPhraseRule } from '@/lib/rules/engine';
import type { RetrievedFact } from '@/lib/retrieval/hybrid';
import type { PipelineFinding } from '@/lib/pipeline/review';

export interface OrgUser {
  id: string;
  email: string;
  name: string;
  role: 'creator' | 'reviewer' | 'admin';
  orgId: string | null;
  orgSlug: string | null;
}

export async function getUserById(id: string): Promise<OrgUser | null> {
  const rows = await sql<OrgUser[]>`
    SELECT u.id, u.email, u.name, u.role, u.org_id AS "orgId", o.slug AS "orgSlug"
    FROM "user" u LEFT JOIN organization o ON o.id = u.org_id
    WHERE u.id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function loadBrandRules(orgId: string): Promise<BrandRules> {
  const rows = await sql<Array<{ kind: string; must_use: string | null; must_avoid: string | null; note: string | null; severity: 'error' | 'warn' }>>`
    SELECT kind, must_use, must_avoid, note, severity FROM guideline
    WHERE org_id = ${orgId} AND active`;
  const terminology: TerminologyRule[] = [];
  const bannedPhrases: BannedPhraseRule[] = [];
  for (const r of rows) {
    if (r.kind === 'terminology' && r.must_use && r.must_avoid) {
      terminology.push({
        id: r.must_use.toLowerCase().replace(/\s+/g, '-'),
        mustUse: r.must_use,
        mustAvoid: r.must_avoid.split('|').map((s) => s.trim()).filter(Boolean),
        severity: r.severity,
        note: r.note ?? undefined,
      });
    } else if (r.kind === 'banned_phrase') {
      bannedPhrases.push({
        id: String(terminology.length + bannedPhrases.length + 1),
        phrase: r.must_avoid ?? r.must_use ?? '',
        severity: r.severity,
        note: r.note ?? undefined,
      });
    }
  }
  return { terminology, bannedPhrases };
}

export async function loadFacts(orgId: string): Promise<Array<RetrievedFact & { embedding: number[] | null }>> {
  const rows = await sql<Array<{
    id: string; fact_key: string; statement: string; source_title: string | null;
    source_url: string | null; source_quote: string | null; superseded_by: string | null; embedding: string | null;
  }>>`
    SELECT id, fact_key, statement, source_title, source_url, source_quote, superseded_by,
           CASE WHEN embedding IS NULL THEN NULL ELSE embedding::text END AS embedding
    FROM fact WHERE org_id = ${orgId} ORDER BY created_at`;
  return rows.map((r) => ({
    factId: r.id,
    factKey: r.fact_key,
    statement: r.statement,
    sourceTitle: r.source_title,
    sourceUrl: r.source_url,
    sourceQuote: r.source_quote,
    superseded: r.superseded_by !== null,
    // pgvector returns "[1,2,3]"; embeddings are computed app-side on write
    embedding: r.embedding ? (JSON.parse(r.embedding) as number[]) : null,
  }));
}

export interface DraftRow {
  id: string;
  org_id: string;
  title: string;
  content: string;
  content_plain: string;
  draft_sha256: string;
}

export async function getDraft(id: string): Promise<DraftRow | null> {
  const rows = await sql<DraftRow[]>`
    SELECT id, org_id, title, content, content_plain AS "content_plain", draft_sha256 AS "draft_sha256"
    FROM draft WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Approval-policy input: the LATEST completed review of this exact content
 * hash (not a union of all runs — a stale blocking finding from an early
 * run must not block a draft whose latest review is clean).
 */
export async function reviewStatusForHash(
  draftId: string,
  sha: string,
): Promise<{ reviewed: boolean; lane: string | null; findings: Array<{ state: string; resolved: boolean }> }> {
  const run = await sql<Array<{ id: string; lane: string }>>`
    SELECT id, lane FROM review_run
    WHERE draft_id = ${draftId} AND draft_sha256 = ${sha} AND finished_at IS NOT NULL
    ORDER BY started_at DESC LIMIT 1`;
  if (!run[0]) return { reviewed: false, lane: null, findings: [] };
  const findings = await sql<Array<{ state: string; resolved: boolean }>>`
    SELECT state, resolved FROM finding WHERE run_id = ${run[0].id}`;
  return { reviewed: true, lane: run[0].lane, findings };
}

export async function listDrafts(orgId: string) {
  return sql<Array<{ id: string; title: string; draft_sha256: string; updated_at: string; approved: boolean }>>`
    SELECT d.id, d.title, d.draft_sha256, d.updated_at,
           EXISTS (
             SELECT 1 FROM approval a
             WHERE a.draft_id = d.id AND a.decision = 'approved' AND a.revoked_at IS NULL
               AND a.draft_sha256 = d.draft_sha256
           ) AS approved
    FROM draft d WHERE d.org_id = ${orgId} ORDER BY d.updated_at DESC`;
}

export async function upsertDraft(orgId: string, userId: string, id: string | null, title: string, content: string, plain: string, sha: string) {
  if (id) {
    // org_id in the predicate: a forged id from another organisation must
    // not be updatable (the route also checks ownership first)
    const rows = await sql<Array<{ id: string }>>`
      UPDATE draft SET title = ${title}, content = ${content}, content_plain = ${plain},
              draft_sha256 = ${sha}, updated_at = now()
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING id`;
    if (!rows[0]) throw new Error('draft not found in this organisation');
    return rows[0].id;
  }
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO draft (org_id, title, content, content_plain, draft_sha256, created_by)
    VALUES (${orgId}, ${title}, ${content}, ${plain}, ${sha}, ${userId})
    RETURNING id`;
  return rows[0].id;
}

export async function insertReviewRun(
  draftId: string, sha: string, lane: 'deterministic' | 'full', userId: string, durationMs: number,
  orgId: string, findings: PipelineFinding[],
): Promise<string> {
  const run = await sql<Array<{ id: string }>>`
    INSERT INTO review_run (draft_id, draft_sha256, lane, started_by, finished_at, duration_ms)
    VALUES (${draftId}, ${sha}, ${lane}, ${userId}, now(), ${durationMs})
    RETURNING id`;
  const runId = run[0].id;
  for (const f of findings) {
    await sql`
      INSERT INTO finding (run_id, org_id, state, start_offset, end_offset, excerpt, explanation, gate_detail, rule_ref)
      VALUES (${runId}, ${orgId}, ${f.state}, ${f.start}, ${f.end}, ${f.excerpt.slice(0, 2000)},
              ${f.explanation.slice(0, 2000)}, ${JSON.stringify(f.gateDetail ?? [])}::jsonb, ${f.ruleRef ?? null})`;
  }
  return runId;
}

export async function latestFindings(draftId: string) {
  return sql<Array<{
    id: string; state: string; start_offset: number; end_offset: number;
    excerpt: string; explanation: string; gate_detail: Array<{ gate: number; passed: boolean; detail: string }>; rule_ref: string | null;
  }>>`
    SELECT f.id, f.state, f.start_offset, f.end_offset, f.excerpt, f.explanation, f.gate_detail, f.rule_ref
    FROM finding f
    JOIN review_run r ON r.id = f.run_id
    WHERE r.draft_id = ${draftId}
    ORDER BY r.started_at DESC, f.start_offset
    LIMIT 100`;
}

export async function appendAudit(actor: string | null, orgId: string | null, action: string, payload: unknown) {
  await sql`INSERT INTO audit_log (actor, org_id, action, payload)
            VALUES (${actor}, ${orgId}, ${action}, ${JSON.stringify(payload)}::jsonb)`;
}

export async function listAudit(orgId: string) {
  const rows = await sql<Array<{ seq: number; occurred_at: string; actor: string | null; action: string; payload: unknown; prev_hash: string; row_hash: string }>>`
    SELECT seq, occurred_at, actor, action, payload, prev_hash, row_hash
    FROM audit_log WHERE org_id = ${orgId} ORDER BY seq`;
  return rows;
}

export interface ApprovalRow {
  id: string; draft_id: string; draft_sha256: string; decided_by: string;
  decision: 'approved' | 'rejected'; rationale: string | null; decided_at: string;
  revoked_at: string | null;
}

export async function listApprovals(draftId: string): Promise<ApprovalRow[]> {
  return sql<ApprovalRow[]>`
    SELECT id, draft_id, draft_sha256, decided_by, decision, rationale, decided_at, revoked_at
    FROM approval WHERE draft_id = ${draftId} ORDER BY decided_at DESC`;
}

export async function recordApproval(
  draftId: string, sha: string, userId: string, decision: 'approved' | 'rejected', rationale: string | null,
) {
  await sql`INSERT INTO approval (draft_id, draft_sha256, decided_by, decision, rationale)
            VALUES (${draftId}, ${sha}, ${userId}, ${decision}, ${rationale})`;
}

export async function revokeApprovals(draftId: string, reason: string) {
  await sql`UPDATE approval SET revoked_at = now(), revoked_reason = ${reason}
            WHERE draft_id = ${draftId} AND revoked_at IS NULL`;
}

export async function upsertFact(orgId: string, userId: string, fact: {
  factKey: string; statement: string; sourceTitle?: string; sourceUrl?: string; sourceQuote?: string; embedding?: number[] | null;
}) {
  // supersede current versions of this key, then insert the new version
  await sql`UPDATE fact SET effective_to = now(), superseded_by = gen_random_uuid()
            WHERE org_id = ${orgId} AND fact_key = ${fact.factKey} AND effective_to IS NULL`;
  await sql`
    INSERT INTO fact (org_id, fact_key, statement, source_title, source_url, source_quote, created_by, embedding)
    VALUES (${orgId}, ${fact.factKey}, ${fact.statement}, ${fact.sourceTitle ?? null}, ${fact.sourceUrl ?? null},
            ${fact.sourceQuote ?? null}, ${userId}, ${fact.embedding ? JSON.stringify(fact.embedding) : null}::vector)`;
}

export async function openReReviewFlags(draftId: string) {
  return sql<Array<{ id: string; reason: string; ref: string }>>`
    SELECT id, reason, ref_id AS ref FROM re_review_flag
    WHERE draft_id = ${draftId} AND resolved_at IS NULL`;
}
