/**
 * The six-state epistemic schema. Every finding carries exactly one state,
 * and the state decides how the UI presents it and what action is possible.
 *
 * Mapping from gate outcomes:
 *   Gate 1 fail (no candidate source in closed set)  -> unsupported
 *   Gate 2 fail (quote not verbatim in source)       -> unverifiable
 *   Gate 3 entailment = contradiction                -> contradicts_fact
 *   Gate 3 entailment = entailment across 2+ sources -> sources_conflict
 *   Deterministic puffery pattern                    -> promotional_puffery
 *   Gate 3 entailment = supported                    -> compliant
 *   Gate 3 in uncertainty band (0.45-0.65)           -> routed to human, no state
 */

export const STATES = [
  'contradicts_fact',
  'unsupported',
  'unverifiable',
  'sources_conflict',
  'promotional_puffery',
  'compliant',
  'accessibility_issue',
] as const;

export type FindingState = (typeof STATES)[number];

export interface StateMeta {
  label: string;
  /** One-line meaning shown on the finding card. */
  meaning: string;
  /** Card accent color token (CSS variable name in the workbench). */
  tone: 'red' | 'amber' | 'blue' | 'green';
  /** Whether a human decision is required before the draft can be approved. */
  blocks: boolean;
}

export const STATE_META: Record<FindingState, StateMeta> = {
  contradicts_fact: {
    label: 'Contradicts a fact',
    meaning: 'The approved sources say the opposite of this sentence.',
    tone: 'red',
    blocks: true,
  },
  unsupported: {
    label: 'Unsupported claim',
    meaning: 'No approved source backs this claim. Add a source or soften it.',
    tone: 'amber',
    blocks: true,
  },
  unverifiable: {
    label: 'Unverifiable citation',
    meaning: 'The cited source could not be checked against its own text.',
    tone: 'amber',
    blocks: true,
  },
  sources_conflict: {
    label: 'Sources conflict',
    meaning: 'Approved sources disagree; a human must pick which applies.',
    tone: 'blue',
    blocks: true,
  },
  promotional_puffery: {
    label: 'Promotional puffery',
    meaning: 'Superlative marketing language with no factual basis allowed by the guidelines.',
    tone: 'amber',
    blocks: false,
  },
  compliant: {
    label: 'Compliant',
    meaning: 'Checked against the approved sources; supported.',
    tone: 'green',
    blocks: false,
  },
  accessibility_issue: {
    label: 'Accessibility issue',
    meaning: 'Deterministic WCAG check failed on this element (contrast, alt text, heading order, link text).',
    tone: 'amber',
    blocks: false,
  },
};

export function isFindingState(x: string): x is FindingState {
  return (STATES as readonly string[]).includes(x);
}
