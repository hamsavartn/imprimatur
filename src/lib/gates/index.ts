/**
 * The three verification gates. Every AI-proposed finding must pass all
 * three before it can be stored as evidence-backed. Any failure demotes the
 * finding to an honest state (unsupported / unverifiable) instead of
 * silently keeping a confident claim.
 *
 * Gate 1 — closed set: the cited source must be one of the organisation's
 * approved fact rows (by fact id/key). No external, unverifiable citations.
 *
 * Gate 2 — verbatim quote: the claimed supporting quote must appear in the
 * fact's source text, after light normalization (case, punctuation spacing,
 * quote marks, whitespace). A paraphrase fails the gate.
 *
 * Gate 3 — entailment: does the source text actually entail the claim?
 * A deterministic lexical-overlap checker runs first; a model-based NLI
 * pass (models.ts) is used when overlap is inconclusive. The confidence
 * band [0.45, 0.65) routes to HUMAN REVIEW rather than a verdict —
 * uncertainty is surfaced, never rounded into a decision.
 */

import type { RetrievedFact } from '../retrieval/hybrid';

export const UNCERTAINTY_BAND: readonly [number, number] = [0.45, 0.65];

export type Gate3Verdict =
  | { kind: 'entailed'; confidence: number }
  | { kind: 'contradicted'; confidence: number }
  | { kind: 'neutral'; confidence: number }
  | { kind: 'human'; confidence: number; reason: string };

export interface GateOutcome {
  gate: 1 | 2 | 3;
  passed: boolean;
  detail: string;
}

export interface GatesResult {
  passed: boolean;
  outcomes: GateOutcome[];
  finalState:
    | 'contradicts_fact'
    | 'unsupported'
    | 'unverifiable'
    | 'sources_conflict'
    | 'compliant'
    | 'human_review';
  confidence: number | null;
}

/** Normalization shared by Gate 2 (and only Gate 2; offsets never use this). */
export function normalizeForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    // sentence punctuation is not evidence; a quote must not fail on it
    .replace(/[.,;:!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------- Gate 1: closed set ----------------

export interface ClaimCitation {
  /** what the draft sentence claims */
  claimText: string;
  /** the source the AI wants to cite: must reference an approved fact */
  citedFactId?: string;
  citedFactKey?: string;
  /** verbatim quote the AI says supports the claim */
  quote: string;
}

export function gate1ClosedSet(
  citation: ClaimCitation,
  approvedFacts: RetrievedFact[],
): { passed: boolean; fact: RetrievedFact | null; detail: string } {
  const byId = citation.citedFactId
    ? approvedFacts.find((f) => f.factId === citation.citedFactId)
    : undefined;
  const byKey = citation.citedFactKey
    ? approvedFacts.find((f) => f.factKey === citation.citedFactKey)
    : undefined;
  const fact = byId ?? byKey ?? null;
  if (!fact) {
    return {
      passed: false,
      fact: null,
      detail: 'Cited source is not in the organisation\'s approved fact set.',
    };
  }
  return { passed: true, fact, detail: `Approved fact ${fact.factKey}.` };
}

// ---------------- Gate 2: verbatim quote ----------------

export function gate2VerbatimQuote(quote: string, fact: RetrievedFact): { passed: boolean; detail: string } {
  // a genuine quote is contiguous inside ONE source segment (the stored
  // source quote, or the approved statement); a quote stitched across the
  // two is not verbatim, so segments are checked individually
  const segments = [fact.sourceQuote ?? '', fact.statement]
    .filter((s) => s.trim().length > 0)
    .map((s) => normalizeForQuote(s));
  const needle = normalizeForQuote(quote);
  if (!needle) return { passed: false, detail: 'Empty quote.' };
  if (segments.some((seg) => seg.includes(needle))) {
    return { passed: true, detail: 'Quote appears verbatim (normalized) in the approved source.' };
  }
  // diagnose the near-miss: same segment, one word skipped
  const words = needle.split(' ');
  for (let cut = 1; cut < words.length - 1; cut++) {
    const a = words.slice(0, cut).join(' ');
    const b = words.slice(cut + 1).join(' ');
    if (a && b && segments.some((seg) => seg.includes(a) && seg.includes(b))) {
      return {
        passed: false,
        detail: 'Quote matches the source only after skipping a word; treated as non-verbatim.',
      };
    }
  }
  return { passed: false, detail: 'Quote does not appear in the approved source text.' };
}

// ---------------- Gate 3: entailment ----------------

const BOUND_PHRASES = /\b(up to|at most|no more than|less than|fewer than|at least|no fewer than|more than|minimum of|maximum of|minimum|maximum)\b/g;
// n't without a leading \b: "can't"/"don't"/"won't" have a word char before n
const NEGATION = /(?:\b(?:not|never|no|cannot|without)\b)|n't\b/g;
const MODAL = /\b(may|might|could|can|planned|upcoming|future|expects to)\b/;

/** Normalized numeric tokens: "1,000"->"1000", "$49.00"->"49", "99.90"->"99.9". */
export function extractNumbers(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((n) => n.replace(/,/g, ''))
    .map((n) => (n.includes('.') ? n.replace(/\.?0+$/, '') : n))
    .filter((n) => n !== '');
}

/**
 * Semantic guard rails shared by the lexical checker AND the model-judge
 * path: returns the maximum confidence this claim/source pair may carry on
 * lexical evidence alone. Disagreement classes (numbers, negation, modality,
 * bound direction, antonyms, hedges) cap into or below the human band; a
 * confident model judge is clamped by the same cap and can never override
 * any of them.
 */
/** Number set: normalized digit numbers ("1,000"->"1000") + word-numbers ("four"->"4"). */
function numberSet(s: string): Set<string> {
  const out = new Set(extractNumbers(s));
  for (const w of s.toLowerCase().split(/[^a-z]+/)) {
    const mapped = WORD_NUMBERS[w];
    if (mapped) out.add(mapped);
  }
  return out;
}

export function semanticCap(claim: string, source: string): number {
  const cl = claim.toLowerCase();
  const sl = source.toLowerCase();
  let cap = 1;

  // numbers: every number the claim asserts must appear in the source
  const cNums = [...numberSet(cl)];
  if (cNums.length > 0) {
    const sNums = numberSet(sl);
    if (!cNums.every((n) => sNums.has(n))) cap = Math.min(cap, 0.35);
  }

  for (const [a, b] of ANTONYMS) {
    if ((a.test(cl) && b.test(sl)) || (b.test(cl) && a.test(sl))) {
      cap = Math.min(cap, 0.55);
    }
  }
  const stripBounds = (s: string) => s.replace(BOUND_PHRASES, ' ');
  const cStrip = stripBounds(cl);
  const sStrip = stripBounds(sl);
  const negCount = (s: string) => (s.match(NEGATION) ?? []).length;
  if (negCount(cStrip) !== negCount(sStrip)) {
    cap = Math.min(cap, 0.5);
  } else if (negCount(cStrip) > 0) {
    // negation on both sides: lexical checks cannot establish the polarity
    // ("not disabled" vs "not enabled" have equal counts, opposite meanings)
    cap = Math.min(cap, 0.6);
  }
  if (MODAL.test(sStrip) && !MODAL.test(cStrip)) {
    cap = Math.min(cap, 0.6);
  }
  // bound direction: "no more than" reads as UPPER (matched before the bare
  // "more than" pattern could read as lower), so compatible upper bounds do
  // not clash with themselves
  const boundDirection = (s: string): 'upper' | 'lower' | 'none' => {
    if (/\b(up to|at most|no more than|less than|fewer than|maximum)/.test(s)) return 'upper';
    if (/\b(at least|no fewer than|more than|minimum)/.test(s)) return 'lower';
    return 'none';
  };
  const cd = boundDirection(cl);
  const sd = boundDirection(sl);
  if ((cd === 'upper' && sd === 'lower') || (cd === 'lower' && sd === 'upper')) {
    cap = Math.min(cap, 0.5);
  }
  // numbers the source explicitly bounds ("up to 100"): a claim asserting
  // that same number without the bound is the classic overclaim
  const boundedNumbers = new Set(
    [...sl.matchAll(/\b(?:up to|at most|no more than|less than|fewer than|at least|no fewer than|more than|minimum(?: of)?|maximum(?: of)?)\s*(\d[\d,]*(?:\.\d+)?)/gi)]
      .map((m) => (m[1].includes('.') ? m[1].replace(/,/g, '').replace(/\.?0+$/, '') : m[1].replace(/,/g, ''))),
  );
  if (sd !== 'none' && cd === 'none' && cNums.length > 0 && cNums.some((n) => boundedNumbers.has(n))) {
    cap = Math.min(cap, 0.6);
  }
  // a claim that ADDS a bound the source never states is a scope change
  if (cd !== 'none' && sd === 'none') {
    cap = Math.min(cap, 0.6);
  }
  if (/\b(about|around|approximately|roughly|nearly|almost)\b/.test(cl)) {
    cap = Math.min(cap, 0.6);
  }
  return cap;
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'by', 'as', 'at', 'it', 'its', 'this', 'that', 'these',
  'those', 'from', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'our', 'their',
]);

const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', twenty: '20', 'twenty-four': '24', thirty: '30', forty: '40',
  fifty: '50', sixty: '60', ninety: '90', hundred: '100', thousand: '1000',
};

/** Directional antonym pairs: matching one side against the other caps confidence. */
const ANTONYMS: Array<[RegExp, RegExp]> = [
  [/including/, /excluding/],
  [/\bwith\b/, /\bwithout\b/],
  [/\bincreases?\b/, /decreases?|reduces?/],
];

function tokens(s: string): string[] {
  const norm = normalizeForQuote(s)
    .replace(/twenty-four/g, '24')
    .replace(/[^a-z0-9\s]/g, ' '); // hyphens separate: "out-of-the-box" == "out of the box"
  return norm.split(/\s+/).map((w) => WORD_NUMBERS[w] ?? w).filter((w) => w && !STOP.has(w));
}

export { tokens as entailTokens };

/** Numerical tokens must match exactly: numbers are where brand claims break. */
export function lexicalEntailment(claim: string, source: string): number {
  const c = tokens(claim);
  const s = new Set(tokens(source));
  if (c.length === 0) return 0.5;
  let hit = 0;
  for (const w of c) {
    if (s.has(w)) hit++;
  }
  let score = hit / c.length;
  // numbers are compared as a union of normalized digit numbers and
  // word-mapped tokens: a claim number missing from the source vetoes;
  // all present boosts
  const cNums = numberSet(claim);
  if (cNums.size > 0) {
    const sNums = numberSet(source);
    score = [...cNums].every((n) => sNums.has(n)) ? Math.min(1, score + 0.15) : Math.min(score, 0.35);
  }
  // the shared semantic guard rails (negation, modality, bounds, antonyms,
  // hedges, numbers) apply to every path, lexical or model-assisted
  score = Math.min(score, semanticCap(claim, source));
  return Math.max(0, Math.min(1, score));
}

export function inUncertaintyBand(c: number): boolean {
  return c >= UNCERTAINTY_BAND[0] && c < UNCERTAINTY_BAND[1];
}

export interface EntailmentJudge {
  /** Returns calibrated confidence in [-1, 1]: sign = direction, |v| = strength. */
  (claim: string, source: string): Promise<number>;
}

/**
 * Full Gate 3. The lexical pass is deterministic and always runs; the model
 * judge refines when lexical is inconclusive (below 0.35 or in the band).
 */
export async function gate3Entailment(
  claim: string,
  source: string,
  modelJudge?: EntailmentJudge,
): Promise<Gate3Verdict> {
  const lex = lexicalEntailment(claim, source);

  if (modelJudge) {
    let v: number;
    try {
      v = await modelJudge(claim, source);
    } catch {
      v = lex; // provider down: fall back to lexical, never to guessing
    }
    // Routing semantics (the caps bind SUPPORT only — contradiction is the
    // safe direction and routes on the judge's raw strength):
    //  - strong negative signal => contradicted (confidence reported clamped
    //    for display, verdict NOT softened into the human band)
    //  - strong positive signal => entailed ONLY if the clamped confidence
    //    still clears 0.65; a cap can downgrade support to human/neutral
    //  - clamped confidence inside the band => human review
    const conf = Math.min(Math.abs(v), semanticCap(claim, source));
    if (v <= -0.65) return { kind: 'contradicted', confidence: conf };
    if (v >= 0.65 && conf >= 0.65) return { kind: 'entailed', confidence: conf };
    if (inUncertaintyBand(conf)) {
      return { kind: 'human', confidence: conf, reason: 'Model confidence inside the uncertainty band.' };
    }
    return { kind: 'neutral', confidence: conf };
  }

  // lexical-only path (benchmark offline mode, provider fully down)
  if (lex >= 0.65) return { kind: 'entailed', confidence: lex };
  if (inUncertaintyBand(lex)) {
    return { kind: 'human', confidence: lex, reason: 'Lexical confidence inside the uncertainty band.' };
  }
  return { kind: 'neutral', confidence: lex };
}

// ---------------- Full gate run ----------------

export async function runGates(
  citation: ClaimCitation,
  approvedFacts: RetrievedFact[],
  modelJudge?: EntailmentJudge,
): Promise<GatesResult> {
  const outcomes: GateOutcome[] = [];

  const g1 = gate1ClosedSet(citation, approvedFacts);
  outcomes.push({ gate: 1, passed: g1.passed, detail: g1.detail });
  if (!g1.passed || !g1.fact) {
    return { passed: false, outcomes, finalState: 'unsupported', confidence: null };
  }

  const g2 = gate2VerbatimQuote(citation.quote, g1.fact);
  outcomes.push({ gate: 2, passed: g2.passed, detail: g2.detail });
  if (!g2.passed) {
    return { passed: false, outcomes, finalState: 'unverifiable', confidence: null };
  }

  // citing a superseded version of a fact is a conflict in itself: the draft
  // is quoting wording the organisation has since replaced, and a human must
  // decide which version governs — this check precedes entailment on purpose
  if (g1.fact.superseded) {
    outcomes.push({
      gate: 3,
      passed: false,
      detail: `Cites a superseded version of ${g1.fact.factKey}; the current approved wording differs.`,
    });
    return { passed: false, outcomes, finalState: 'sources_conflict', confidence: null };
  }

  const source = [g1.fact.sourceQuote, g1.fact.statement].filter(Boolean).join('\n');
  const g3 = await gate3Entailment(citation.claimText, source, modelJudge);
  const g3Passed = g3.kind === 'entailed' || g3.kind === 'contradicted';
  outcomes.push({
    gate: 3,
    passed: g3Passed,
    detail: `${g3.kind} (confidence ${g3.confidence.toFixed(2)}${g3.kind === 'human' ? `; ${g3.reason}` : ''})`,
  });

  if (g3.kind === 'human') {
    return { passed: false, outcomes, finalState: 'human_review', confidence: g3.confidence };
  }
  if (g3.kind === 'contradicted') {
    return { passed: false, outcomes, finalState: 'contradicts_fact', confidence: g3.confidence };
  }
  if (g3.kind === 'neutral') {
    return { passed: false, outcomes, finalState: 'unsupported', confidence: g3.confidence };
  }

  return { passed: true, outcomes, finalState: 'compliant', confidence: g3.confidence };
}
