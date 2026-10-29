import { getSessionUser, unauthorized } from '@/lib/session';
import { getDraft, recordApproval, appendAudit, revokeApprovals, reviewStatusForHash } from '@/db/repo';
import { assertApprovalActionable, approvalBlockers, recordDecision, StaleApprovalError, UnauthorizedApprovalError, type ApprovalRecord } from '@/lib/workflow/approval';
import { AUDIT_ACTIONS } from '@/lib/audit/chain';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const { id } = await params;
  const body = (await req.json()) as { decision: 'approved' | 'rejected'; rationale?: string };
  // validate the decision verb BEFORE touching any state: a malformed
  // request must not revoke anything
  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    return Response.json({ error: 'decision must be "approved" or "rejected".' }, { status: 400 });
  }
  const draft = await getDraft(id);
  if (!draft || draft.org_id !== user.orgId) return Response.json({ error: 'Not found.' }, { status: 404 });

  // server-side approval policy: approval requires the LATEST completed
  // review of the CURRENT content hash with no unresolved blocking findings.
  // A direct API call cannot bypass this by hiding findings from the UI.
  const status = await reviewStatusForHash(id, draft.draft_sha256);
  if (!status.reviewed) {
    return Response.json({ error: 'This content has no completed review. Run a review before deciding.' }, { status: 409 });
  }
  const blockers = approvalBlockers(status.findings);
  if (body.decision === 'approved' && blockers.length > 0) {
    return Response.json({ error: `Blocked: ${blockers.length} unresolved finding(s) (${[...new Set(blockers)].join(', ')}) require resolution before approval.` }, { status: 409 });
  }
  // degraded-mode disclosure: an approval whose review ran without the
  // grounding lane is recorded and returned as such, never silent
  const degraded = status.lane === 'deterministic';

  try {
    const record: ApprovalRecord = recordDecision(
      id, draft.draft_sha256, { id: user.id, role: user.role }, body.decision, body.rationale,
    );
    assertApprovalActionable(record, draft.draft_sha256);
    await recordApproval(id, draft.draft_sha256, user.id, body.decision, body.rationale ?? null);
    if (body.decision === 'rejected') {
      await revokeApprovals(id, 'rejected by reviewer');
    }
    await appendAudit(user.id, user.orgId,
      body.decision === 'approved' ? AUDIT_ACTIONS.approvalGranted : AUDIT_ACTIONS.approvalRevoked,
      { draftId: id, sha256: draft.draft_sha256, rationale: body.rationale ?? null,
        reviewLane: status.lane, degradedReview: degraded });
    return Response.json({
      ok: true,
      boundSha256: draft.draft_sha256,
      reviewLane: status.lane,
      ...(degraded ? { warning: 'Approved from a deterministic-only review: grounding findings were not available when this review ran.' } : {}),
    });
  } catch (e) {
    if (e instanceof StaleApprovalError || e instanceof UnauthorizedApprovalError) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
