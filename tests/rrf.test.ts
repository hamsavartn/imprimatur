import { describe, expect, it } from 'vitest';
import { rrfMerge, keywordScore, cosineSimilarity, retrieveInMemory } from '../src/lib/retrieval/hybrid';

const A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };

describe('rrfMerge', () => {
  it('items found by both lanes outrank single-lane items', () => {
    const merged = rrfMerge(
      [
        { items: [{ item: A, score: 0.9 }, { item: B, score: 0.8 }] },
        { items: [{ item: B, score: 0.7 }, { item: C, score: 0.6 }] },
      ],
      50,
      (x) => x.id,
    );
    expect(merged[0].item.id).toBe('b'); // rank 2 + rank 1
    expect(merged.find((m) => m.item.id === 'a')!.lanes).toHaveLength(1);
    expect(merged.find((m) => m.item.id === 'b')!.lanes).toHaveLength(2);
  });
  it('exact product codes surface via the keyword lane', () => {
    expect(keywordScore('MF-2200 pricing', 'The MF-2200 module handles pricing')).toBeGreaterThan(0);
  });
});

describe('retrieveInMemory', () => {
  const facts = [
    { factId: '1', factKey: 'k1', statement: 'The Basic plan costs $49 per workspace per month.', sourceTitle: null, sourceUrl: null, sourceQuote: null, embedding: null },
    { factId: '2', factKey: 'k2', statement: 'Founded in 2021 and headquartered in Coimbatore.', sourceTitle: null, sourceUrl: null, sourceQuote: null, embedding: null },
  ];
  it('finds the pricing fact for a pricing query', () => {
    const out = retrieveInMemory('What does the Basic plan cost per month?', [], facts, 5);
    expect(out[0]?.factKey).toBe('k1');
  });
  it('returns nothing for unrelated queries', () => {
    const out = retrieveInMemory('kittens', [], facts, 5);
    expect(out).toHaveLength(0);
  });
  it('cosine similarity is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});
