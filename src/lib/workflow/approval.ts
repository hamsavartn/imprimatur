/**
 * Change safety. Approvals bind to the exact content hash; any edit makes
 * every prior approval unusable, and that rule is enforced HERE, in code,
 * not by UI convention. Unauthorised approvals (wrong role) throw.
 */

export interface ApprovalRecord {
  draftId: string;
  draftSha256: string;
  decidedBy: string;
  role: 'creator' | 'reviewer' | 'admin';
  decision: 'approved' | 'rejected';
  rationale?: string;
  revokedAt?: string | null;
}

export class StaleApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleApprovalError';
  }
}

export class UnauthorizedApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedApprovalError';
  }
}

/** Only reviewers and admins may approve. Creators request review. */
export function canApprove(role: ApprovalRecord['role']): boolean {
  return role === 'reviewer' || role === 'admin';
}

/**
 * Guard every approval action: the draft's CURRENT hash must equal the hash
 * the decision was made against, and the actor must hold the right role.
 * Throws instead of returning false — a blocked path must be loud.
 */
export function assertApprovalActionable(
  approval: ApprovalRecord,
  currentDraftSha256: string,
): void {
  if (approval.revokedAt) {
    throw new StaleApprovalError('This approval was revoked and cannot be used.');
  }
  if (approval.draftSha256 !== currentDraftSha256) {
    throw new StaleApprovalError(
      'The draft changed after this decision. The content hash no longer matches; re-review and decide again.',
    );
  }
}

/** The single entry point the workflow uses when recording a decision. */
export function recordDecision(
  draftId: string,
  currentDraftSha256: string,
  actor: { id: string; role: ApprovalRecord['role'] },
  decision: 'approved' | 'rejected',
  rationale: string | undefined,
): ApprovalRecord {
  if (decision === 'approved' && !canApprove(actor.role)) {
    throw new UnauthorizedApprovalError(
      `Role "${actor.role}" cannot approve. Approval is reserved for reviewers and admins.`,
    );
  }
  if (rationale !== undefined && decision === 'approved' && rationale.trim().length > 0 && rationale.trim().length < 15) {
    throw new Error('An override rationale must be at least 15 characters; say why the finding is acceptable.');
  }
  return {
    draftId,
    draftSha256: currentDraftSha256,
    decidedBy: actor.id,
    role: actor.role,
    decision,
    rationale,
    revokedAt: null,
  };
}

/**
 * "Is this draft currently approved?" — true only when an active approval
 * exists whose hash equals the draft's current hash.
 */
export function isCurrentlyApproved(
  approvals: ApprovalRecord[],
  draftId: string,
  currentDraftSha256: string,
): boolean {
  return approvals.some(
    (a) =>
      a.draftId === draftId &&
      a.decision === 'approved' &&
      !a.revokedAt &&
      a.draftSha256 === currentDraftSha256,
  );
}

const BLOCKING_STATES = new Set([
  'contradicts_fact', 'unsupported', 'unverifiable', 'sources_conflict', 'human_review',
]);

export interface ApprovalCandidateFinding {
  state: string;
  resolved?: boolean;
}

/**
 * Server-side approval policy. An approval requires findings from a completed
 * review of the CURRENT content hash in which every blocking finding is
 * resolved. Advisory states (puffery) and compliant findings do not block.
 * The API route consults this directly; UI state is never trusted.
 */
export function approvalBlockers(findings: ApprovalCandidateFinding[]): string[] {
  return findings
    .filter((f) => !f.resolved && BLOCKING_STATES.has(f.state))
    .map((f) => f.state);
}
