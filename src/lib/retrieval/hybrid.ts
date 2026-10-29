/**
 * Hybrid retrieval: keyword (tsvector) + vector lanes fused with Reciprocal
 * Rank Fusion. In production the fusion happens inside Postgres
 * (search_facts_hybrid in db/schema.sql). This module owns:
 *   - the DB call and typed result,
 *   - a pure client-side RRF implementation used in tests and in the
 *     benchmark harness without a live database,
 *   - the embedding provider seam (models.ts plugs in here).
 */

export const RRF_K = 50;

export interface RetrievedFact {
  factId: string;
  factKey: string;
  statement: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  sourceQuote: string | null;
  /** true when a newer approved version of this factKey exists */
  superseded?: boolean;
}

export interface LaneRanking<T> {
  items: Array<{ item: T; score: number }>;
}

/** Pure RRF: merge ranked lists into one ranking. Deterministic, no DB. */
export function rrfMerge<T>(
  lanes: Array<LaneRanking<T>>,
  k: number = RRF_K,
  keyOf: (t: T) => string,
): Array<{ item: T; score: number; lanes: number[] }> {
  const acc = new Map<string, { item: T; score: number; lanes: number[] }>();
  for (const lane of lanes) {
    lane.items.forEach(({ item }, idx) => {
      const rank = idx + 1;
      const contrib = 1 / (k + rank);
      const key = keyOf(item);
      const cur = acc.get(key) ?? { item, score: 0, lanes: [] };
      cur.score += contrib;
      cur.lanes.push(rank);
      acc.set(key, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** Light stem so "encryption" matches "encrypted" in the recall lane. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ions|ion|ing|ed|es|s)$/, '').replace(/e$/, '');
}

/** Keyword-lane scorer for tests/benchmark: substring + stemmed token overlap. */
export function keywordScore(query: string, statement: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const qTokens = new Set(norm(query).map(stem));
  const sTokens = norm(statement).map(stem);
  if (sTokens.length === 0) return 0;
  let hits = 0;
  for (const t of sTokens) if (qTokens.has(t)) hits++;
  const overlap = hits / sTokens.length;
  const direct = statement.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0;
  return overlap + direct;
}

/** Cosine similarity for tests/benchmark (vectors already unit-normalized upstream). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Test/benchmark retrieval: run both lanes over an in-memory fact set and
 * fuse. Production uses the SQL function; this keeps semantics identical
 * (k per lane, RRF_K damping) so benchmark numbers transfer.
 */
export function retrieveInMemory(
  query: string,
  queryEmbedding: number[],
  facts: Array<RetrievedFact & { embedding: number[] | null }>,
  k: number = 5,
): Array<RetrievedFact & { score: number }> {
  const textLane: LaneRanking<RetrievedFact> = {
    items: facts
      .map((f) => ({ item: f as RetrievedFact, score: keywordScore(query, f.statement) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k),
  };
  const vecLane: LaneRanking<RetrievedFact> = {
    items: facts
      .filter((f) => f.embedding)
      .map((f) => ({
        item: f as RetrievedFact,
        score: cosineSimilarity(queryEmbedding, f.embedding as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k),
  };
  return rrfMerge([textLane, vecLane], RRF_K, (f) => f.factId)
    .slice(0, k)
    .map(({ item, score }) => ({ ...item, score }));
}
