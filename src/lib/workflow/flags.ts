/**
 * Re-review flags: brand knowledge changed, so already-approved content that
 * cited it must come back through review. The DB triggers the same events in
 * production; this module is the shared, testable predicate.
 */

export interface FlagInput {
  draftId: string;
  draftSha256: string;
  isApproved: boolean;
  /** fact keys cited by the draft's evidence-backed findings */
  citedFactKeys: string[];
}

export interface KnowledgeChange {
  kind: 'fact_edited' | 'fact_expired' | 'guideline_edited';
  /** fact key or guideline id affected */
  ref: string;
}

export interface ReReviewFlag {
  draftId: string;
  reason: KnowledgeChange['kind'];
  ref: string;
}

/**
 * Which approved drafts must be re-reviewed given a set of knowledge changes?
 * A draft is flagged when it cites the changed fact, or (for guideline
 * changes) when it was approved under the old rules at all — tone rules
 * apply to every sentence, so an approval cannot survive a guideline edit.
 */
export function flagsFor(
  drafts: FlagInput[],
  change: KnowledgeChange,
): ReReviewFlag[] {
  const out: ReReviewFlag[] = [];
  for (const d of drafts) {
    if (!d.isApproved) continue;
    const cited =
      change.kind === 'guideline_edited' || d.citedFactKeys.includes(change.ref);
    if (cited) out.push({ draftId: d.draftId, reason: change.kind, ref: change.ref });
  }
  return out;
}
