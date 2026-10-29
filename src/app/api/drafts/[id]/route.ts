import { getSessionUser, unauthorized } from '@/lib/session';
import { getDraft, latestFindings, listApprovals, openReReviewFlags } from '@/db/repo';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft || draft.org_id !== user.orgId) return Response.json({ error: 'Not found.' }, { status: 404 });
  const [findings, approvals, flags] = await Promise.all([
    latestFindings(id), listApprovals(id), openReReviewFlags(id),
  ]);
  return Response.json({
    draft,
    findings,
    approvals,
    reReviewFlags: flags,
    approvedNow: approvals.some((a) => a.decision === 'approved' && !a.revoked_at && a.draft_sha256 === draft.draft_sha256),
  });
}
