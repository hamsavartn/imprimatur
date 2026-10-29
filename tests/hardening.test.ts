/**
 * Second-mission hardening cases: confidential-mode zero-network proof,
 * bounded model-output validation (zod exhaustion advisory), malformed
 * provider output degradation, payload limits, and claim-coverage
 * disclosure. These tests instrument the seams directly.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { ModelGateway } from '../src/lib/models';
import { runReview } from '../src/lib/pipeline/review';
import { draftTooLarge, titleTooLong, MAX_DRAFT_CHARS } from '../src/lib/validate';
import { RULES, FACTS } from '../seed/meridian-flow';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('confidential mode performs ZERO network calls (invariant 9)', () => {
  it('extractClaims throws without ever calling fetch', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; throw new Error('NETWORK REACHED'); }) as typeof fetch;
    const gw = new ModelGateway({ confidential: true });
    await expect(gw.extractClaims('text', 'context')).rejects.toThrow(/confidential/i);
    expect(fetchCalls).toBe(0);
  });
  it('entailmentJudge and embed also make zero calls', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls++; throw new Error('NETWORK REACHED'); }) as typeof fetch;
    const gw = new ModelGateway({ confidential: true });
    await expect(gw.entailmentJudge('a', 'b')).rejects.toThrow(/confidential/i);
    expect(await gw.embed(['x'])).toBeNull();
    expect(fetchCalls).toBe(0);
  });
});

describe('bounded model-output validation (zod exhaustion advisory)', () => {
  it('a provider response larger than the raw cap is rejected before zod parsing', async () => {
    const { parseBounded, extractedClaimSchema } = await import('../src/lib/models');
    const entry = '{"claim":"' + 'x'.repeat(100) + '"},';
    const huge = '{"claims":[' + entry.repeat(4000) + ']}';
    expect(huge.length).toBeGreaterThan(256_000);
    expect(() => parseBounded(huge, extractedClaimSchema)).toThrow(/too large/);
    // a normal-sized response still parses
    const ok = parseBounded('{"claims":[]}', extractedClaimSchema);
    expect(ok.claims).toHaveLength(0);
  });
  it('claims beyond the per-paragraph cap are dropped, not parsed into memory', async () => {
    // direct schema-level proof of the cap behavior
    const { extractedClaimSchema } = await import('../src/lib/models');
    const many = Array.from({ length: 200 }, (_, i) => ({
      claim: `claim ${i}`, quote: '', factId: '', factKey: '', start: i, end: i + 1,
    }));
    const parsed = extractedClaimSchema.parse({ claims: many });
    expect(parsed.claims).toHaveLength(200); // schema accepts; the GATEWAY caps
    const gw = new ModelGateway({ geminiKey: 'k', confidential: false });
    // exercise the gateway cap through parseBounded by stubbing the provider call
    (gw as unknown as { call: unknown }).call = async () => ({
      text: JSON.stringify({ claims: many }),
      provider: 'gemini' as const,
    });
    const out = await gw.extractClaims('p', 'c');
    expect(out.claims.length).toBeLessThanOrEqual(50);
  });
});

describe('malformed provider output degrades, never fabricates', () => {
  it('garbage JSON from extraction: paragraph skipped with a degradation note, deterministic findings kept', async () => {
    const res = await runReview({
      content: 'MeridianFlow wrote this. The Basic plan costs $49 per workspace per month.',
      format: 'markdown',
      brandRules: RULES,
      approvedFacts: FACTS,
      gateway: {
        provider: 'gemini',
        embed: async () => null,
        extractClaims: async () => { throw new Error('Unexpected token < in JSON'); },
        entailmentJudge: async () => { throw new Error('down'); },
      },
    });
    expect(res.degradation.some((d) => d.includes('claim extraction failed'))).toBe(true);
    expect(res.findings.some((f) => f.excerpt.includes('MeridianFlow'))).toBe(true);
    expect(res.findings.every((f) => f.lane === 'deterministic')).toBe(true);
    expect(res.claimsExtracted).toBe(0);
  });
});

describe('claim-coverage disclosure (invariant 14)', () => {
  it('deterministic-only runs report claimsExtracted = 0 and say so', async () => {
    const res = await runReview({
      content: 'MeridianFlow shipped.',
      format: 'markdown',
      brandRules: RULES,
      approvedFacts: FACTS,
      gateway: { provider: 'none', embed: async () => null, extractClaims: async () => ({ claims: [] }), entailmentJudge: async () => 0 },
    });
    expect(res.claimsExtracted).toBe(0);
    expect(res.degradation.length).toBeGreaterThan(0);
  });
  it('oracle runs report the extracted count honestly', async () => {
    const { makeOracleGateway } = await import('../benchmark/oracle');
    const res = await runReview({
      content: 'The Basic plan costs $49 per workspace per month. Uptime was 99.9% last year.',
      format: 'markdown',
      brandRules: RULES,
      approvedFacts: FACTS.map((f) => ({ ...f, embedding: null })),
      gateway: makeOracleGateway(FACTS),
    });
    expect(res.claimsExtracted).toBeGreaterThan(0);
  });
});

describe('payload limits at the API boundary', () => {
  it('drafts over the limit are rejected', () => {
    expect(draftTooLarge('x'.repeat(MAX_DRAFT_CHARS + 1))).toBe(true);
    expect(draftTooLarge('x'.repeat(1000))).toBe(false);
  });
  it('overlong titles are rejected', () => {
    expect(titleTooLong('t'.repeat(301))).toBe(true);
    expect(titleTooLong('ok title')).toBe(false);
  });
});
