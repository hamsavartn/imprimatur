import { sql } from '@/db/client';
import { getSessionUser, unauthorized } from '@/lib/session';
import { getDraft } from '@/db/repo';

export const dynamic = 'force-dynamic';

/**
 * The compliance certificate (Round 3 improvement 3): a machine-checkable
 * JSON artifact for the draft's current approved version. It carries the
 * content hash, the decision record, the review summary and the audit-chain
 * verification result. What it proves: this content, at this hash, passed
 * this review and was approved by this role. What it does NOT prove: that
 * the underlying sources were correct, or issuer identity beyond the
 * recorded account.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft || draft.org_id !== user.orgId) return Response.json({ error: 'Not found.' }, { status: 404 });

  const approvals = await sql<Array<{ decision: string; decided_by: string; decided_at: string; draft_sha256: string; rationale: string | null; revoked_at: string | null }>>`
    SELECT decision, decided_by, decided_at::text, draft_sha256, rationale, revoked_at::text
    FROM approval WHERE draft_id = ${id} ORDER BY decided_at DESC`;
  const active = approvals.find((a) => a.decision === 'approved' && !a.revoked_at && a.draft_sha256 === draft.draft_sha256);

  const run = await sql<Array<{ id: string; lane: string; started_at: string; duration_ms: number | null; draft_sha256: string }>>`
    SELECT id, lane, started_at::text, duration_ms, draft_sha256 FROM review_run
    WHERE draft_id = ${id} AND draft_sha256 = ${draft.draft_sha256} AND finished_at IS NOT NULL
    ORDER BY started_at DESC LIMIT 1`;
  const findings = run[0]
    ? await sql<Array<{ state: string; count: number }>>`
        SELECT state, count(*)::int AS count FROM finding WHERE run_id = ${run[0].id} GROUP BY state`
    : [];
  const chain = await sql<Array<{ ok: boolean; first_bad: string | null; reason: string | null }>>`
    SELECT ok, first_bad, reason FROM audit_verify_chain()`;
  const decider = active
    ? await sql<Array<{ name: string; email: string; role: string }>>`
        SELECT name, email, role FROM "user" WHERE id = ${active.decided_by}`
    : [];

  if (!active) {
    return Response.json(
      { certified: false, reason: 'No active approval bound to the current content hash. Approve the current version first.' },
      { status: 409 },
    );
  }

  return Response.json({
    certificate: {
      version: 1,
      product: 'Imprimatur',
      draftId: id,
      title: draft.title,
      contentSha256: draft.draft_sha256,
      approved: {
        by: decider[0] ? { name: decider[0].name, email: decider[0].email, role: decider[0].role } : null,
        at: active.decided_at,
        boundToSha256: active.draft_sha256,
        rationale: active.rationale,
      },
      review: run[0]
        ? {
            runId: run[0].id,
            lane: run[0].lane,
            findingsByState: Object.fromEntries(findings.map((f) => [f.state, f.count])),
            durationMs: run[0].duration_ms,
          }
        : null,
      auditChain: {
        ok: chain[0]?.ok ?? false,
        breakAt: chain[0]?.first_bad ?? null,
        // the chain is one global append-only log: verification walks every
        // row across organisations, so tampering ANYWHERE is visible to
        // everyone. That is a feature (global tamper evidence), stated here.
        scope: 'global',
      },
      scope:
        'This certificate attests that the content identified by contentSha256 completed the recorded review and received the recorded approval. It does not attest that the underlying approved sources are factually correct, and it does not establish issuer identity beyond the recorded account.',
    },
  });
}
