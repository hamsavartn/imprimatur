/**
 * The review pipeline. Two lanes:
 *
 *   Deterministic lane (always runs, <300ms, no network):
 *     normalizer -> terminology/banned/puffery/injection rules
 *
 *   Grounding lane (runs unless confidential mode; provider failure
 *   degrades gracefully, never blocks):
 *     paragraph split -> claim extraction (model) -> hybrid retrieval ->
 *     three gates -> six-state findings
 *
 * The merge keeps every finding with plain-text offsets so the workbench can
 * highlight in place, and records lane + per-gate detail for the audit trail.
 */

import { normalizeDraft, type Normalized } from '../normalizer';
import { runTerminologyRules, sentenceAround, type BrandRules, type RuleFinding } from '../rules/engine';
import { runAccessibilityChecks } from '../rules/accessibility';
import { retrieveInMemory, type RetrievedFact } from '../retrieval/hybrid';
import { runGates } from '../gates';
import type { ExtractedClaims, ProviderId } from '../models';
import type { FindingState } from '../states';

/**
 * The pipeline depends on this seam, not on ModelGateway directly, so the
 * benchmark can run fully offline with a deterministic oracle gateway.
 */
export interface PipelineGateway {
  provider: ProviderId;
  embed(texts: string[]): Promise<number[][] | null>;
  extractClaims(paragraph: string, context: string): Promise<ExtractedClaims>;
  entailmentJudge(claim: string, source: string): Promise<number>;
}

export interface PipelineFinding {
  state: FindingState | 'human_review';
  start: number;
  end: number;
  excerpt: string;
  explanation: string;
  ruleRef?: string;
  factKey?: string;
  gateDetail?: Array<{ gate: 1 | 2 | 3; passed: boolean; detail: string }>;
  confidence: number | null;
  lane: 'deterministic' | 'grounding';
}

export interface ReviewInput {
  content: string;
  format: 'markdown' | 'html';
  brandRules: BrandRules;
  approvedFacts: Array<RetrievedFact & { embedding?: number[] | null }>;
  gateway: PipelineGateway;
}

export interface ReviewResult {
  normalized: Normalized;
  lane: 'deterministic' | 'full';
  findings: PipelineFinding[];
  durationMs: number;
  degradation: string[];   // e.g. "model unavailable: grounding lane skipped"
  /**
   * Claim-coverage disclosure: extraction cannot be proven complete, so the
   * result must never present itself as "fully verified". This count feeds
   * that disclosure (0 in deterministic-only mode means NO claim was checked).
   */
  claimsExtracted: number;
}

function splitParagraphs(plain: string): Array<{ text: string; start: number }> {
  const paras: Array<{ text: string; start: number }> = [];
  let idx = 0;
  for (const chunk of plain.split('\n')) {
    const lead = plain.indexOf(chunk, idx);
    if (chunk.trim()) paras.push({ text: chunk.trim(), start: lead });
    idx = lead + chunk.length;
  }
  return paras;
}

/** Clamp claim offsets (from a model) into the paragraph range; distrust but keep. */
function clampOffsets(start: number, end: number, paraStart: number, paraLen: number): [number, number] {
  const s = Math.max(0, Math.min(start, paraLen - 1));
  const e = Math.max(s + 1, Math.min(end, paraLen));
  return [paraStart + s, paraStart + e];
}

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const t0 = Date.now();
  const degradation: string[] = [];
  const normalized = normalizeDraft(input.content, input.format);
  const findings: PipelineFinding[] = [];

  // ---- deterministic lane ----
  const ruleFindings: RuleFinding[] = runTerminologyRules(normalized.plain, input.brandRules);
  for (const f of ruleFindings) {
    findings.push({
      state: f.state,
      start: f.start,
      end: f.end,
      excerpt: f.excerpt,
      explanation: f.explanation,
      ruleRef: f.ruleRef,
      confidence: 1,
      lane: 'deterministic',
    });
  }

  // accessibility checks run on the sanitized HTML (Round 3 improvement 2);
  // advisory, deterministic, no offsets (they identify elements, not spans)
  for (const a of runAccessibilityChecks(normalized.html)) {
    findings.push({
      state: 'accessibility_issue',
      start: 0,
      end: 0,
      excerpt: a.excerpt,
      explanation: a.explanation,
      ruleRef: a.rule,
      confidence: 1,
      lane: 'deterministic',
    });
  }

  // ---- grounding lane ----
  const modelUp = input.gateway.provider !== 'none';
  if (!modelUp) {
    degradation.push('no external model available: grounding lane skipped, deterministic findings only');
  }

  let claimsExtracted = 0;
  if (modelUp) {
    const paragraphs = splitParagraphs(normalized.plain);
    for (const para of paragraphs) {
      // retrieval context for this paragraph
      let retrieved: Array<RetrievedFact & { score: number }> = [];
      try {
        const emb = (await input.gateway.embed([para.text]))?.[0] ?? null;
        const pool = input.approvedFacts.map((f) => ({ ...f, embedding: f.embedding ?? null }));
        retrieved = retrieveInMemory(para.text, emb ?? [], pool, 5);
      } catch {
        degradation.push('embedding failed: keyword lane only');
        retrieved = retrieveInMemory(
          para.text, [],
          input.approvedFacts.map((f) => ({ ...f, embedding: null })),
          5,
        );
      }
      const context = retrieved
        .map((f) => `[${f.factKey}] ${f.statement}${f.sourceQuote ? `\n  quote: ${f.sourceQuote}` : ''}`)
        .join('\n\n');

      // claim extraction
      let rawClaims: Array<{ claim: string; quote: string; factId: string; factKey: string; start: number; end: number }>;
      try {
        const out = await input.gateway.extractClaims(para.text, context);
        rawClaims = out.claims;
        if (out.truncatedClaims) {
          degradation.push(`claim cap reached in one paragraph: claims beyond ${50} were dropped (coverage reduced, disclosed)`);
        }
        claimsExtracted += rawClaims.length;
      } catch (e) {
        const msg = String(e);
        const cleanMsg = msg.includes('503') || msg.includes('429')
          ? 'model provider quota/capacity limit reached (grounding degraded to deterministic)'
          : msg.includes('AbortError')
          ? 'model request timed out (grounding degraded to deterministic)'
          : `claim extraction failed for one paragraph (${msg.slice(0, 80)})`;
        if (!degradation.includes(cleanMsg)) {
          degradation.push(cleanMsg);
        }
        continue;
      }

      for (const c of rawClaims) {
        const [start, end] = clampOffsets(c.start, c.end, para.start, para.text.length);
        // don't double-flag a span the deterministic lane already owns
        const overlapsRule = ruleFindings.some((rf) => start < rf.end && end > rf.start);
        if (overlapsRule) continue;
        const excerpt = normalized.plain.slice(start, end) || sentenceAround(normalized.plain, start, end);
        const gatesResult = await runGates(
          { claimText: c.claim, quote: c.quote, citedFactId: c.factId || undefined, citedFactKey: c.factKey || undefined },
          retrieved,
          (claim, source) => input.gateway.entailmentJudge(claim, source),
        );
        findings.push({
          state: gatesResult.finalState,
          start,
          end,
          excerpt,
          explanation:
            gatesResult.finalState === 'human_review'
              ? `Uncertain (${gatesResult.confidence?.toFixed(2)}): a reviewer must check "${c.claim}" against the source.`
              : gatesResult.finalState === 'compliant'
                ? `Supported by approved fact ${c.factKey}.`
                : `Claim "${c.claim}": ${gatesResult.outcomes.map((o) => `G${o.gate} ${o.passed ? 'pass' : 'fail'} (${o.detail})`).join('; ')}`,
          factKey: c.factKey || undefined,
          gateDetail: gatesResult.outcomes,
          confidence: gatesResult.confidence,
          lane: 'grounding',
        });
      }
    }
  }

  findings.sort((a, b) => a.start - b.start);
  return {
    normalized,
    lane: modelUp ? 'full' : 'deterministic',
    findings,
    durationMs: Date.now() - t0,
    degradation,
    claimsExtracted,
  };
}
