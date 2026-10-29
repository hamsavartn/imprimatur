/**
 * Adversarial regression cases from the red-team audit. These are separate
 * from the golden benchmark (which is untouched) and pin the repaired
 * defect classes: negation/modality/bound blindness in lexical entailment,
 * stitched quotes in Gate 2, server-side approval policy, and gate-order
 * integrity (a confident model judge cannot resurrect a failed gate).
 */

import { describe, expect, it } from 'vitest';
import { gate3Entailment, gate2VerbatimQuote, runGates } from '../src/lib/gates';
import { approvalBlockers } from '../src/lib/workflow/approval';
import { runReview } from '../src/lib/pipeline/review';
import { RULES, FACTS } from '../seed/meridian-flow';

describe('negation and modality minimal pairs (audit F1)', () => {
  it('claim asserting what the source denies is NOT entailed', async () => {
    const v = await gate3Entailment(
      'The product supports offline mode.',
      'The product does not support offline mode.',
    );
    expect(v.kind).not.toBe('entailed');
  });
  it('assertion over a hedged source is NOT entailed', async () => {
    const v = await gate3Entailment('The service reduces costs.', 'The service may reduce costs.');
    expect(v.kind).not.toBe('entailed');
  });
  it('available over planned is NOT entailed', async () => {
    const v = await gate3Entailment('The feature is available.', 'The feature is planned for release.');
    expect(v.kind).not.toBe('entailed');
  });
  it('double negation still fails: "not unavailable" vs "unavailable"', async () => {
    const v = await gate3Entailment('The API is not unavailable.', 'The API is unavailable.');
    expect(v.kind).not.toBe('entailed');
  });
});

describe('quantity bound minimal pairs (audit F1c)', () => {
  it('"Up to 50 users" over "50 concurrent users" routes to a human', async () => {
    const v = await gate3Entailment('Up to 50 users can connect.', '50 concurrent users can connect.');
    expect(['human', 'neutral']).toContain(v.kind);
  });
  it('compatible upper bounds still pass: "no more than 10 ms" vs "less than 10 ms"', async () => {
    const v = await gate3Entailment('Latency is no more than 10 ms.', 'Latency is less than 10 ms.');
    expect(v.kind).toBe('entailed');
  });
  it('opposite bound directions route to a human: "at least 10" vs "no more than 10"', async () => {
    const v = await gate3Entailment('Latency is at least 10 ms.', 'Latency is no more than 10 ms.');
    expect(v.kind).not.toBe('entailed');
  });
});

describe('Gate 2 quote stitching (audit F2)', () => {
  const fact = {
    factId: 'x', factKey: 'k', statement: 'Integrates with Zoho Books and Tally.',
    sourceTitle: null, sourceUrl: null, sourceQuote: 'The standard library ships',
  };
  it('rejects a quote stitched across the stored quote and the statement', () => {
    expect(gate2VerbatimQuote('library ships Integrates with Zoho', fact).passed).toBe(false);
  });
  it('still accepts a quote fully inside one segment', () => {
    expect(gate2VerbatimQuote('The standard library ships', fact).passed).toBe(true);
    expect(gate2VerbatimQuote('Integrates with Zoho Books', fact).passed).toBe(true);
  });
  it('rejects a quote with negation removed from the segment', () => {
    const neg = { ...fact, sourceQuote: 'The product does not support offline mode.' };
    expect(gate2VerbatimQuote('The product does support offline mode', neg).passed).toBe(false);
  });
});

describe('gate order integrity: a confident judge cannot bypass a failed gate (audit 4.4)', () => {
  it('judge says supported but the source is not in the closed set: unsupported', async () => {
    const r = await runGates(
      { claimText: 'Anything.', quote: 'whatever', citedFactKey: 'not/in/set' },
      FACTS,
      async () => 0.99,
    );
    expect(r.finalState).toBe('unsupported');
  });
  it('judge says supported but the quote is not verbatim: unverifiable', async () => {
    const r = await runGates(
      { claimText: 'The Basic plan costs $49.', quote: 'costs forty-nine dollars monthly', citedFactKey: 'pricing/basic-plan' },
      FACTS,
      async () => 0.99,
    );
    expect(r.finalState).toBe('unverifiable');
  });
  it('judge says supported but the claim denies the source: not compliant', async () => {
    const r = await runGates(
      {
        claimText: 'The Basic plan does not include workflows.',
        quote: 'Includes up to 3 active automation workflows',
        citedFactId: 'f-pricing',
      },
      FACTS,
      async () => 0.99,
    );
    expect(r.finalState).not.toBe('compliant');
  });
});

describe('server-side approval policy (audit F4)', () => {
  it('unresolved blocking findings block approval', () => {
    expect(approvalBlockers([
      { state: 'compliant' },
      { state: 'contradicts_fact' },
      { state: 'human_review' },
    ])).toEqual(['contradicts_fact', 'human_review']);
  });
  it('advisory puffery and compliant findings do not block', () => {
    expect(approvalBlockers([{ state: 'promotional_puffery' }, { state: 'compliant' }])).toEqual([]);
  });
  it('resolved findings do not block', () => {
    expect(approvalBlockers([{ state: 'unsupported', resolved: true }])).toEqual([]);
  });
});

describe('independent-reviewer findings (second pass)', () => {
  const pricing = FACTS.find((f) => f.factId === 'f-pricing')!;

  it('R1: number veto binds a confident judge ($59 claim over $49 fact)', async () => {
    const r = await runGates(
      { claimText: 'The Basic plan costs $59 per workspace per month.', quote: 'costs $49 per workspace per month', citedFactId: 'f-pricing' },
      FACTS,
      async () => 0.99,
    );
    expect(r.finalState).not.toBe('compliant');
  });
  it('R1b: 95% vs 99.9% uptime cannot pass with a confident judge', async () => {
    const r = await runGates(
      { claimText: 'Uptime was 95% last year.', quote: 'recorded 99.9% uptime', citedFactId: 'f-uptime' },
      FACTS,
      async () => 0.99,
    );
    expect(r.finalState).not.toBe('compliant');
  });
  it('R2: can\'t vs can flips polarity and is caught', async () => {
    const v = await gate3Entailment("You can't export to CSV.", 'You can export to CSV.');
    expect(v.kind).not.toBe('entailed');
  });
  it('R2b: won\'t over affirmative source is caught', async () => {
    const v = await gate3Entailment("The feature won't ship in 2026.", 'The feature ships in 2026.');
    expect(v.kind).not.toBe('entailed');
  });
  it('R3: equal negation counts with opposite polarity route to a human', async () => {
    const v = await gate3Entailment('Exports are not disabled for your org.', 'Exports are not enabled for your org.');
    expect(['human', 'neutral']).toContain(v.kind);
  });
  it('reviewer D6: a strong CONTRADICTION routes as contradicted even when capped (safe direction)', async () => {
    const v = await gate3Entailment(
      'The product does not support offline mode.',
      'The product supports offline mode.',
      async () => -0.9,
    );
    expect(v.kind).toBe('contradicted');
  });
  it('reviewer D6: a strong SUPPORT claim that is semantically capped never becomes entailed', async () => {
    const v = await gate3Entailment(
      'The product supports offline mode.',
      'The product does not support offline mode.',
      async () => 0.9,
    );
    expect(v.kind).not.toBe('entailed');
  });
  it('R4: point claim over a bounded source is the classic overclaim', async () => {
    const v = await gate3Entailment('The plan supports 100 team members.', 'The plan supports up to 100 team members.');
    expect(v.kind).not.toBe('entailed');
  });
  it('R5: thousand separators and decimal zeros do not false-veto', async () => {
    const v = await gate3Entailment('Supports 1,000 concurrent users.', 'The platform supports 1000 concurrent users.');
    expect(v.kind).toBe('entailed');
    const v2 = await gate3Entailment('The plan costs $49.00 per month.', 'The plan costs $49 per month.');
    expect(v2.kind).toBe('entailed');
  });
  it('R5b: verdict is provider-independent for the same pair', async () => {
    const lexical = await gate3Entailment('The plan costs $49.00 per month.', 'The plan costs $49 per month.');
    const judged = await gate3Entailment('The plan costs $49.00 per month.', 'The plan costs $49 per month.', async () => 0.99);
    expect(lexical.kind).toBe('entailed');
    expect(judged.kind).toBe('entailed');
  });
  it('R6: word-numbers normalize (thirteen vs 13)', async () => {
    const v = await gate3Entailment('The kit costs thirteen dollars.', 'The kit costs 13 dollars.');
    expect(v.kind).toBe('entailed');
  });
});

describe('provider-down degradation cannot fabricate findings (audit 6.3)', () => {
  it('no provider means degradation notes and zero grounding findings', async () => {
    const res = await runReview({
      content: 'The Basic plan costs $49 per workspace per month and MeridianFlow wrote this.',
      format: 'markdown',
      brandRules: RULES,
      approvedFacts: FACTS,
      gateway: {
        provider: 'none',
        embed: async () => null,
        extractClaims: async () => { throw new Error('no provider'); },
        entailmentJudge: async () => { throw new Error('no provider'); },
      },
    });
    expect(res.lane).toBe('deterministic');
    expect(res.degradation.length).toBeGreaterThan(0);
    expect(res.findings.every((f) => f.lane === 'deterministic')).toBe(true);
    expect(res.findings.some((f) => f.state === 'compliant')).toBe(false);
    // the deterministic terminology finding still fires
    expect(res.findings.some((f) => f.excerpt.includes('MeridianFlow'))).toBe(true);
  });
});
