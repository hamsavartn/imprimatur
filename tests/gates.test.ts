import { describe, expect, it } from 'vitest';
import {
  gate1ClosedSet, gate2VerbatimQuote, gate3Entailment, lexicalEntailment, runGates, inUncertaintyBand,
} from '../src/lib/gates';
import { FACTS } from '../seed/meridian-flow';

const pricing = FACTS.find((f) => f.factId === 'f-pricing')!;
const slaOld = FACTS.find((f) => f.factId === 'f-sla-old')!;
const sla = FACTS.find((f) => f.factId === 'f-sla')!;

describe('gate 1: closed set', () => {
  it('accepts an approved fact', () => {
    expect(gate1ClosedSet({ claimText: 'x', quote: 'y', citedFactKey: 'pricing/basic-plan' }, FACTS).passed).toBe(true);
  });
  it('rejects anything not in the approved set', () => {
    const r = gate1ClosedSet({ claimText: 'x', quote: 'y', citedFactKey: 'not/a-fact' }, FACTS);
    expect(r.passed).toBe(false);
  });
});

describe('gate 2: verbatim quote', () => {
  it('accepts an exact quote', () => {
    expect(gate2VerbatimQuote('Includes up to 3 active automation workflows', pricing).passed).toBe(true);
  });
  it('accepts quotes after punctuation and case normalization', () => {
    expect(gate2VerbatimQuote('includes up to 3 ACTIVE automation workflows!', pricing).passed).toBe(true);
  });
  it('rejects paraphrases', () => {
    expect(gate2VerbatimQuote('lets you run three workflows automatically', pricing).passed).toBe(false);
  });
  it('rejects quotes with a skipped word', () => {
    expect(gate2VerbatimQuote('up to active automation workflows', pricing).passed).toBe(false);
  });
});

describe('gate 3: entailment', () => {
  it('numbers carry veto power', () => {
    const ok = lexicalEntailment('The plan costs $49 per month', 'The plan costs $49 per month');
    const bad = lexicalEntailment('The plan costs $39 per month', 'The plan costs $49 per month');
    expect(ok).toBeGreaterThan(0.6);
    expect(bad).toBeLessThan(0.4);
  });
  it('word-numbers normalize (four -> 4)', () => {
    const s = 'first response within 4 business hours';
    expect(lexicalEntailment('replies within four hours', s)).toBeGreaterThan(
      lexicalEntailment('replies within five hours', s),
    );
  });
  it('directional antonyms cap into the uncertainty band', () => {
    const s = 'uptime 99.9% excluding scheduled maintenance';
    expect(lexicalEntailment('uptime 99.9% including scheduled maintenance', s)).toBeLessThanOrEqual(0.55);
  });
  it('mid confidence routes to human review', async () => {
    const v = await gate3Entailment('claim', 'source', async () => 0.55);
    expect(v.kind).toBe('human');
  });
  it('strong model contradiction is a contradiction', async () => {
    const v = await gate3Entailment('claim', 'source', async () => -0.8);
    expect(v.kind).toBe('contradicted');
  });
  it('provider failure falls back to lexical, never to guessing', async () => {
    const v = await gate3Entailment('the plan costs 49 dollars monthly', 'the plan costs 49 dollars monthly', async () => {
      throw new Error('down');
    });
    expect(v.kind).toBe('entailed');
  });
});

describe('full gate run', () => {
  it('a correct claim with a verbatim quote passes compliant', async () => {
    const r = await runGates({
      claimText: 'The Basic plan costs $49 per workspace per month.',
      quote: 'Basic — $49 per workspace per month.',
      citedFactKey: 'pricing/basic-plan',
    }, FACTS);
    expect(r.finalState).toBe('compliant');
    expect(r.passed).toBe(true);
  });
  it('citing a superseded fact routes to sources_conflict', async () => {
    const r = await runGates({
      claimText: 'Our team responds to every ticket within 24 hours.',
      quote: 'Our team responds to every ticket within 24 hours.',
      citedFactId: 'f-sla-old',
    }, FACTS);
    expect(r.finalState).toBe('sources_conflict');
  });
  it('current fact stays compliant despite an old version existing', async () => {
    const r = await runGates({
      claimText: 'First response within 4 business hours.',
      quote: 'first response within 4 business hours',
      citedFactKey: 'reliability/support-sla',
    }, FACTS);
    expect(r.finalState).toBe('compliant');
  });
  it('uncited claims become unsupported', async () => {
    const r = await runGates({ claimText: 'x', quote: '', citedFactKey: 'nope' }, FACTS);
    expect(r.finalState).toBe('unsupported');
  });
  it('inUncertaintyBand covers [0.45, 0.65)', () => {
    expect(inUncertaintyBand(0.4499)).toBe(false);
    expect(inUncertaintyBand(0.45)).toBe(true);
    expect(inUncertaintyBand(0.6499)).toBe(true);
    expect(inUncertaintyBand(0.65)).toBe(false);
  });
});
