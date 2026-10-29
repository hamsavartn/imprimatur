/**
 * Model access, with the properties the product promises:
 *   - schema-constrained structured output (JSON schemas validated with zod),
 *   - provider fallback (Gemini free tier -> GLM paid) so a quota error on
 *     judging day is a non-event,
 *   - a confidential mode that hard-blocks external calls,
 *   - timeouts per stage so the pipeline meets its latency budget.
 *
 * The claim-extraction and entailment prompts live here, versioned, because
 * they are part of the auditable behaviour of the product.
 */

import { z } from 'zod';

export type ProviderId = 'gemini' | 'glm' | 'none' | 'local';

export interface ModelConfig {
  geminiKey?: string;
  geminiModel?: string;
  zaiKey?: string;
  zaiModel?: string;
  confidential: boolean;
  /** per-call timeout ms (pipeline budget: claim stage < 8s) */
  timeoutMs?: number;
}

// ---------------- structured outputs ----------------

export const extractedClaimSchema = z.object({
  claims: z.array(
    z.object({
      /** the checkable factual assertion, as a standalone sentence */
      claim: z.string().min(4),
      /** verbatim quote from the approved source that supports it, if any */
      quote: z.string().default(''),
      /** fact id from the retrieval context (preferred over factKey: unique across versions) */
      factId: z.string().default(''),
      /** fact key from the retrieval context it claims to cite */
      factKey: z.string().default(''),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  ),
  /** set by the gateway when the per-paragraph cap discarded claims */
  truncatedClaims: z.boolean().optional(),
});
export type ExtractedClaims = z.infer<typeof extractedClaimSchema>;

export const CLAIM_EXTRACTION_PROMPT = `You extract checkable factual claims from one paragraph of a marketing draft.
Rules:
- Only claims that a source document could confirm or contradict (numbers, product names, dates, capabilities, comparisons).
- No tone, style or grammar findings. No claims about the reader's feelings.
- For each claim, set start/end to its character offsets in the paragraph text, exactly as given.
- If the retrieval context (approved facts) contains a source for the claim, copy the supporting sentence into "quote" VERBATIM and set "factId" (and "factKey") from that entry. If there is no source, leave quote, factId and factKey empty.
- Never invent a quote. A wrong quote is worse than no quote.
Return JSON: {"claims": [{"claim": string, "quote": string, "factId": string, "factKey": string, "start": int, "end": int}]}`;

// ---------------- provider calls ----------------

interface GeminiOpts {
  key: string;
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
}

async function geminiText(o: GeminiOpts): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${o.model}:generateContent?key=${o.key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: o.system }] },
          contents: [{ role: 'user', parts: [{ text: o.user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    // memory gate BEFORE materializing the body: a hostile provider cannot
    // OOM the pipeline inside res.text() (chunked bodies without the header
    // remain bounded by the post-read parseBounded gate — documented residual)
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_HTTP_BODY_BYTES) throw new Error(`gemini response too large (${declared} bytes)`);
    const text = await res.text();
    if (text.length > MAX_HTTP_BODY_BYTES) throw new Error(`gemini response too large (${text.length} chars)`);
    const data = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const candidateText = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!candidateText) throw new Error('gemini empty');
    return candidateText;
  } finally {
    clearTimeout(t);
  }
}

interface GlmOpts {
  key: string;
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
}

async function glmText(o: GlmOpts): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.key}` },
      signal: ctl.signal,
      body: JSON.stringify({
        model: o.model,
        temperature: 0,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`glm ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_HTTP_BODY_BYTES) throw new Error(`glm response too large (${declared} bytes)`);
    const text = await res.text();
    if (text.length > MAX_HTTP_BODY_BYTES) throw new Error(`glm response too large (${text.length} chars)`);
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const choiceText = data.choices?.[0]?.message?.content ?? '';
    if (!choiceText) throw new Error('glm empty');
    return choiceText;
  } finally {
    clearTimeout(t);
  }
}

/** Strip markdown fences some providers wrap around JSON, and normalize shape. */
function parseJsonLoose(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(s);
  if (Array.isArray(parsed)) {
    return { claims: parsed };
  }
  if (parsed && typeof parsed === 'object') {
    if (!('claims' in parsed)) {
      const anyP = parsed as Record<string, unknown>;
      if (Array.isArray(anyP.result)) return { claims: anyP.result };
      if (Array.isArray(anyP.extracted_claims)) return { claims: anyP.extracted_claims };
      if (Array.isArray(anyP.data)) return { claims: anyP.data };
    }
  }
  return parsed;
}

/**
 * Bounded validation: model output is untrusted input, and zod can exhaust
 * memory validating oversized collections (GHSA-mrhx-c7xc-m3w5). Gate the
 * RAW text size before parsing and cap the claims array after — a hostile
 * provider response cannot turn the extraction stage into an OOM.
 */
const MAX_MODEL_JSON_CHARS = 256_000;
const MAX_CLAIMS_PER_PARAGRAPH = 50;
/** Memory gate applied to the HTTP body BEFORE it is materialized. */
const MAX_HTTP_BODY_BYTES = 2_000_000;

export function parseBounded<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
  cap?: (v: z.output<S>) => z.output<S>,
): z.output<S> {
  if (raw.length > MAX_MODEL_JSON_CHARS) {
    throw new Error(`model output too large (${raw.length} chars)`);
  }
  const parsed = schema.parse(parseJsonLoose(raw)) as z.output<S>;
  return cap ? cap(parsed) : parsed;
}

export class ModelGateway {
  constructor(private cfg: ModelConfig) {}

  get provider(): ProviderId {
    if (this.cfg.confidential) return 'none';
    if (this.cfg.geminiKey) return 'gemini';
    if (this.cfg.zaiKey) return 'glm';
    return 'none';
  }

  private async call(system: string, user: string): Promise<{ text: string; provider: ProviderId }> {
    if (this.cfg.confidential) throw new Error('confidential mode: external model calls disabled');
    const timeoutMs = this.cfg.timeoutMs ?? 25_000;
    const errors: string[] = [];
    if (this.cfg.geminiKey) {
      const modelsToTry = Array.from(new Set([
        this.cfg.geminiModel || 'gemini-3.5-flash-lite',
        'gemini-3.5-flash-lite',
      ]));
      for (const m of modelsToTry) {
        try {
          return {
            text: await geminiText({
              key: this.cfg.geminiKey,
              model: m,
              system, user, timeoutMs,
            }),
            provider: 'gemini',
          };
        } catch (e) {
          errors.push(String(e));
        }
      }
    }
    if (this.cfg.zaiKey) {
      try {
        return {
          text: await glmText({
            key: this.cfg.zaiKey,
            model: this.cfg.zaiModel ?? 'glm-4.6',
            system, user, timeoutMs,
          }),
          provider: 'glm',
        };
      } catch (e) {
        errors.push(String(e));
      }
    }
    throw new Error(`all providers failed: ${errors.join('; ')}`);
  }

  /** Claim extraction over one paragraph, with retrieval context. */
  async extractClaims(paragraph: string, context: string): Promise<ExtractedClaims> {
    const user = `PARAGRAPH:\n${paragraph}\n\nAPPROVED FACTS (retrieval context):\n${context || '(none)'}`;
    const raw = await this.call(CLAIM_EXTRACTION_PROMPT, user);
    return parseBounded(raw.text, extractedClaimSchema, (parsed) =>
      parsed.claims.length > MAX_CLAIMS_PER_PARAGRAPH
        ? { ...parsed, claims: parsed.claims.slice(0, MAX_CLAIMS_PER_PARAGRAPH), truncatedClaims: true }
        : parsed,
    );
  }

  /**
   * Entailment judge for Gate 3. Returns a signed confidence in [-1, 1]:
   * negative = source contradicts claim, positive = supports.
   */
  entailmentJudge(claim: string, source: string): Promise<number> {
    const system = `You are a strict fact-verification judge, like MiniCheck.
Given a CLAIM and a SOURCE, output JSON {"verdict": "supports"|"contradicts"|"neutral", "confidence": 0.0-1.0}.
"supports" only if the source text clearly entails the claim. If numbers or named entities disagree, "contradicts". If the source does not address the claim, "neutral". Be calibrated: when unsure, lower the confidence.`;
    const user = `CLAIM: ${claim}\n\nSOURCE: ${source}`;
    return (async () => {
      const raw = await this.call(system, user);
      const out = parseBounded(
        raw.text,
        z.object({ verdict: z.enum(['supports', 'contradicts', 'neutral']), confidence: z.number().min(0).max(1) }),
      );
      const sign = out.verdict === 'contradicts' ? -1 : out.verdict === 'supports' ? 1 : 0;
      return sign * out.confidence; // no floor: routing stays monotonic in strength
    })();
  }

  /** Embedding via Gemini (fallback: caller handles absence by keyword-only). */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (this.cfg.confidential || !this.cfg.geminiKey) return null;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${this.cfg.geminiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requests: texts.map((t) => ({
              model: 'models/text-embedding-004',
              content: { parts: [{ text: t.slice(0, 8000) }] },
            })),
          }),
        },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { embeddings?: Array<{ values: number[] }> };
      return data.embeddings?.map((e) => e.values) ?? null;
    } catch {
      return null;
    }
  }
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    geminiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    zaiKey: env.ZAI_API_KEY,
    zaiModel: env.ZAI_MODEL,
    confidential: env.CONFIDENTIAL_MODE === 'true' || (!env.GEMINI_API_KEY && !env.ZAI_API_KEY),
  };
}
