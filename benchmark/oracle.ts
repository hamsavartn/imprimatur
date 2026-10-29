/**
 * Offline oracle gateway: a deterministic stand-in for the model providers
 * so the benchmark can run with zero API keys. It is deliberately simple
 * and labelled as oracle — offline numbers measure the GATES, RETRIEVAL and
 * PIPELINE mechanics, never the model quality. The live baseline (with real
 * keys) is the number the submission reports.
 *
 * Extraction strategy: split the paragraph into sentences; a sentence
 * becomes a claim when it contains a number, a product/brand word, or a
 * fact-significant token. It cites the retrieval context's best-matching
 * fact (same logic the live prompt follows: copy the fact's source quote
 * verbatim when the sentence overlaps the fact strongly).
 */

import type { PipelineGateway } from '../src/lib/pipeline/review';
import type { ExtractedClaims } from '../src/lib/models';
import { lexicalEntailment, entailTokens, extractNumbers } from '../src/lib/gates';
import type { RetrievedFact } from '../src/lib/retrieval/hybrid';

function splitSentences(p: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let cursor = 0;
  for (const raw of p.split(/(?<=[.!?])\s+/)) {
    const start = p.indexOf(raw, cursor);
    if (raw.trim()) out.push({ text: raw.trim(), start });
    cursor = start + raw.length;
  }
  return out;
}

function isClaimish(sentence: string): boolean {
  return /\d/.test(sentence) || /\b(plan|pricing|uptime|founded|headquartered|integrat|connector|connect|support|encrypt|response|hours|sla|per month|per year|percent|%|twice|fast|save|money|countries|powered)\b/i.test(sentence);
}

function numbersOf(s: string): string[] {
  return [...new Set([...extractNumbers(s), ...(s.match(/(?<![\d,.])\d+(?![\d,.])/g) ?? [])])];
}

/** Capitalized words that are not the first word of the sentence. */
function properNounsOf(claim: string): string[] {
  const words = claim.split(/\s+/);
  return words
    .slice(1)
    .filter((w) => /^[A-Z][a-z]{2,}[.,;:!?]?$/.test(w))
    .map((w) => w.replace(/[.,;:!?]$/, ''));
}

/** Brand tokens appear in every fact; they carry no citation signal. */
const BRAND_TOKENS = new Set(['meridian', 'flow', 'platform', 'product', 'company', 'team', 'we', 'our']);

/**
 * Recall-oriented citation scorer: how much of the CLAIM does this source
 * address? (Precision is Gate 3's job.) Threshold 0.3.
 */
function bestFact(sentence: string, facts: RetrievedFact[]): RetrievedFact | null {
  const cTokens = entailTokens(sentence).filter((t) => !BRAND_TOKENS.has(t));
  if (cTokens.length === 0) return null;
  let best: RetrievedFact | null = null;
  let bestScore = 0;
  const claimNorm = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const f of facts) {
    const src = [f.sourceQuote, f.statement].filter(Boolean).join(' ');
    const sTokens = new Set(entailTokens(src));
    const sNums = new Set(src.match(/\d+(?:\.\d+)?/g) ?? []);
    let hits = 0;
    let numHits = 0;
    for (const t of cTokens) {
      if (sTokens.has(t)) hits++;
      if (/^\d/.test(t) && sNums.has(t)) numHits++;
    }
    // tie-breakers between fact versions: the version whose numbers the
    // claim uses, and the version whose quote the claim quotes verbatim
    const quoteNorm = (f.sourceQuote ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const quoteInClaim = quoteNorm.length > 0 && claimNorm.includes(quoteNorm);
    const score = hits / cTokens.length + 0.05 * numHits + (quoteInClaim ? 0.15 : 0);
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return bestScore >= 0.3 ? best : null;
}

export function makeOracleGateway(facts: RetrievedFact[]): PipelineGateway {
  return {
    provider: 'local',
    async embed() {
      return null; // keyword lane only; vector lane exercised in live runs
    },
    async extractClaims(paragraph: string, context: string): Promise<ExtractedClaims> {
      // context lines look like: "[factKey] statement\n  quote: ..."
      const contextFacts: RetrievedFact[] = [];
      for (const f of facts) {
        if (context.includes(`[${f.factKey}]`)) contextFacts.push(f);
      }
      const claims: ExtractedClaims['claims'] = [];
      for (const s of splitSentences(paragraph)) {
        if (!isClaimish(s.text)) continue;
        const fact = bestFact(s.text, contextFacts.length ? contextFacts : facts);
        const start = s.start;
        const end = start + s.text.length;
        claims.push({
          claim: s.text,
          quote: fact ? (fact.sourceQuote ?? '') : '',
          factId: fact ? fact.factId : '',
          factKey: fact ? fact.factKey : '',
          start,
          end,
        });
      }
      return { claims };
    },
    async entailmentJudge(claim: string, source: string): Promise<number> {
      const lex = lexicalEntailment(claim, source);
      const sNums = numbersOf(source);
      const cNums = numbersOf(claim);
      // a number in the claim that the source does not contain is a
      // contradiction, not a gap
      if (sNums.length > 0 && cNums.some((n) => !sNums.includes(n))) return -0.8;
      // a proper noun the source never mentions (wrong city, wrong product)
      const srcLower = source.toLowerCase();
      const strayProper = properNounsOf(claim).filter((p) => !srcLower.includes(p.toLowerCase()));
      if (strayProper.length > 0 && cNums.length === 0) return -0.75;
      // universal quantifiers are only contradictions when the source itself
      // does not use them while being bounded ("unlimited" vs "3 workflows")
      const universalWord = ['unlimited', 'all', 'every', 'everyone', 'never', 'always']
        .find((w) => new RegExp(`\\b${w}\\b`, 'i').test(claim) && !new RegExp(`\\b${w}\\b`, 'i').test(source));
      if (universalWord && sNums.length > 0) return -0.75;
      if (lex >= 0.65) return Math.min(0.95, lex + 0.1);
      if (lex >= 0.45) return 0.55; // stays in the human band
      return 0.1;
    },
  };
}
