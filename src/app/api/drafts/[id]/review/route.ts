import { getSessionUser, unauthorized } from '@/lib/session';
import { getDraft, loadBrandRules, loadFacts, insertReviewRun, appendAudit } from '@/db/repo';
import { runReview } from '@/lib/pipeline/review';
import { ModelGateway, modelConfigFromEnv } from '@/lib/models';
import { AUDIT_ACTIONS } from '@/lib/audit/chain';

export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft || draft.org_id !== user.orgId) return Response.json({ error: 'Not found.' }, { status: 404 });

  const [rules, facts] = await Promise.all([loadBrandRules(user.orgId), loadFacts(user.orgId)]);
  const gateway = new ModelGateway(modelConfigFromEnv());
  // the format MUST match how POST /api/drafts saved the content (markdown),
  // so the review's content hash is in the same namespace as the draft's —
  // otherwise approvals could never bind to a review of the same text
  const result = await runReview({
    content: draft.content,
    format: 'markdown',
    brandRules: rules,
    approvedFacts: facts,
    gateway,
  });

  const runId = await insertReviewRun(
    id, result.normalized.sha256, result.lane, user.id, result.durationMs, user.orgId, result.findings,
  );
  await appendAudit(user.id, user.orgId, AUDIT_ACTIONS.reviewRun, {
    draftId: id, runId, lane: result.lane, findings: result.findings.length,
    sha256: result.normalized.sha256, degradation: result.degradation,
    claimsExtracted: result.claimsExtracted,
  });

  return Response.json({
    runId,
    lane: result.lane,
    durationMs: result.durationMs,
    degradation: result.degradation,
    claimsExtracted: result.claimsExtracted,
    coverageNote:
      result.lane === 'deterministic'
        ? 'Deterministic-only review: no factual claims were checked against sources.'
        : `${result.claimsExtracted} claim(s) extracted and checked; extraction completeness is not guaranteed — a claim the extractor missed was not verified.`,
    sha256: result.normalized.sha256,
    findings: result.findings,
  });
}
