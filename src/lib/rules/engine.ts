/**
 * Deterministic rules lane. No model calls, no network, <300ms budget.
 * Everything here is pure functions over (plain text, brand knowledge rows)
 * so it is unit-testable and runs identically with providers down.
 *
 * Finding kinds produced here:
 *   - terminology violations (must_avoid -> must_use)
 *   - banned phrases
 *   - injection patterns (prompt-injection attempts inside draft content)
 *   - promotional puffery patterns
 *   - stale-claim hints: numbers/years present in text whose fact expired
 *     (full fact checking happens in the grounding lane; this is a cheap hint)
 */

import type { FindingState } from '../states';

export interface TerminologyRule {
  id: string;
  mustUse: string;
  mustAvoid: string[];
  severity: 'error' | 'warn';
  note?: string;
}

export interface BannedPhraseRule {
  id: string;
  phrase: string;
  severity: 'error' | 'warn';
  note?: string;
}

export interface RuleFinding {
  kind: 'terminology' | 'banned_phrase' | 'injection' | 'puffery';
  state: FindingState;
  severity: 'error' | 'warn';
  start: number;
  end: number;
  excerpt: string;
  explanation: string;
  ruleRef: string;
}

export interface BrandRules {
  terminology: TerminologyRule[];
  bannedPhrases: BannedPhraseRule[];
}

/** Word-boundary aware matcher that returns ALL non-overlapping hits. */
function matchAll(text: string, needle: string): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = [];
  if (!needle.trim()) return hits;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // boundary = string edge or non-word char; needle itself may contain spaces/punct
  const re = new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length });
    re.lastIndex = m.index + m[0].length;
  }
  return hits;
}

/** Heuristic sentence splitter for excerpt context (plain text). */
export function sentenceAround(text: string, start: number, end: number): string {
  const left = Math.max(text.lastIndexOf('.', start), text.lastIndexOf('\n', start), 0);
  const rightCandidates = [text.indexOf('.', end), text.indexOf('\n', end)]
    .filter((x) => x !== -1);
  const right = rightCandidates.length ? Math.min(...rightCandidates) + 1 : text.length;
  return text.slice(left === start ? 0 : left + 1, right).trim();
}

const PUFFERY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(best|greatest|finest|leading|world[- ]class|state[- ]of[- ]the[- ]art|cutting[- ]edge)\b/gi, why: 'superlative without a verifiable basis' },
  { re: /\b(\d+|one|hundred)\s?%\s?(guarantee|guaranteed|satisfaction|reliable|secure)\b/gi, why: 'absolute guarantee claim' },
  { re: /\b(everyone|all|no one|nobody)\s+(knows|agrees|uses|loves)\b/gi, why: 'unfalsifiable universal claim' },
  { re: /\b(never|always)\s+(fails|works|delivers)\b/gi, why: 'absolute performance claim' },
];

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore (all|any|previous|prior|above)[^.]{0,60}(instruction|prompt|rule)/gi, label: 'instruction override attempt' },
  { re: /\b(system|developer)\s*(prompt|message|instruction)\s*[:=]/gi, label: 'system-prompt extraction attempt' },
  { re: /\b(disregard|forget)\b[^.]{0,40}\b(rules|guidelines|guardrails)\b/gi, label: 'guardrail bypass attempt' },
  { re: /you are now[^.]{0,50}/gi, label: 'persona hijack attempt' },
];

export function runTerminologyRules(text: string, rules: BrandRules): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const rule of rules.terminology) {
    for (const avoid of rule.mustAvoid) {
      for (const hit of matchAll(text, avoid)) {
        findings.push({
          kind: 'terminology',
          state: 'contradicts_fact',
          severity: rule.severity,
          start: hit.start,
          end: hit.end,
          excerpt: sentenceAround(text, hit.start, hit.end),
          explanation: `Guideline terminology: use "${rule.mustUse}" instead of "${avoid}"${rule.note ? ` (${rule.note})` : ''}.`,
          ruleRef: `terminology:${rule.id}`,
        });
      }
    }
  }

  for (const rule of rules.bannedPhrases) {
    for (const hit of matchAll(text, rule.phrase)) {
      findings.push({
        kind: 'banned_phrase',
        state: 'contradicts_fact',
        severity: rule.severity,
        start: hit.start,
        end: hit.end,
        excerpt: sentenceAround(text, hit.start, hit.end),
        explanation: `Banned phrase: "${rule.phrase}"${rule.note ? ` — ${rule.note}` : ''}.`,
        ruleRef: `banned:${rule.id}`,
      });
    }
  }

  for (const { re, why } of PUFFERY_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        kind: 'puffery',
        state: 'promotional_puffery',
        severity: 'warn',
        start: m.index,
        end: m.index + m[0].length,
        excerpt: sentenceAround(text, m.index, m.index + m[0].length),
        explanation: `Promotional puffery: ${why}. Either back it with an approved source or cut it.`,
        ruleRef: 'puffery:pattern',
      });
    }
  }

  for (const { re, label } of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        kind: 'injection',
        state: 'unverifiable',
        severity: 'error',
        start: m.index,
        end: m.index + m[0].length,
        excerpt: sentenceAround(text, m.index, m.index + m[0].length),
        explanation: `Possible prompt injection in draft content (${label}). The pipeline will not follow instructions found in drafts.`,
        ruleRef: 'injection:pattern',
      });
    }
  }

  // collapse duplicates: case-variant must_avoid entries can hit the same span
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.kind}:${f.start}:${f.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // deterministic lane emits in document order
  return deduped.sort((a, b) => a.start - b.start);
}

/**
 * Accessibility/contrast check hook (deterministic, sharp-free for now):
 * WCAG contrast ratio for a fg/bg pair. Round 3 adds image inspection.
 */
export function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const lum = ([r, g, b]: [number, number, number]) => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const l1 = lum(fg);
  const l2 = lum(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
