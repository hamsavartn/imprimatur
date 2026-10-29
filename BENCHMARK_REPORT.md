# Benchmark Report — Imprimatur

## Results

| Mode | Stratum A (rules, 10) | B (grounding, 18) | C (conflict/uncertainty, 12) | D (change safety, 10) | Total |
|---|---|---|---|---|---|
| Offline oracle — pre-audit | 10/10 | 15/18 | 10/12 | 10/10 | **47/50 (94%)** |
| Offline oracle — post-audit (current) | 10/10 | 15/18 | 10/12 | 10/10 | **47/50 (94%)** |
| Live providers | not run — **no API keys used in this session** | | | | — |

The identical pre/post score is meaningful: every repair in the audit was made
against the GATES' failure modes, and the golden expectations were never touched.
The three misses (b12 misattributed quote, c03 vague hedged claim, c05 synonym
attachment) are the documented offline-vs-live gap — they need real model
semantics, and they are exactly what the live baseline will measure.

During repair, intermediate states dipped to 42/50 and 46/50 (over-firing caps);
each was root-caused and fixed rather than papered over by changing expectations:
- bound-asymmetry cap fired on unrelated bound phrases (fixed: number-intersection scoping)
- number sets included punctuation fragments ("1","000" from "1,000") and missed
  word-numbers (fixed: normalized extractNumbers + WORD_NUMBERS union)

## False-approval analysis (the metric that matters)

Post-audit, across all 50 cases + 26 adversarial tests: **zero reproducible
false `compliant`/evidence-backed verdicts** — including every attack from the
independent reviewer (wrong numbers + confident judge, stitched quotes,
contractions, negation flips, bound overclaims, non-approved sources).

Scope statement: this claim covers THIS benchmark and THESE adversarial cases
under the offline oracle and lexical-only paths. It is not a claim about live
model behavior; the live baseline is the number that carries that weight.

## Unnecessary human-review routing (cost of honesty)

The caps deliberately route ambiguous cases to humans. Known over-routing after
repair: antonym-word pairs on compatible statements (e.g. "reduces processing
time" vs "increases speed") land in the band. Accepted: a human review is the
correct cost for lexical uncertainty; false approvals are the unacceptable cost.

## Provenance & reproduction

- Golden cases: `benchmark/cases.ts`, written with the demo brand, untouched by the audit.
- Adversarial cases: `tests/adversarial.test.ts`, added BY the audit, separate file, separate concerns.
- Oracle: `benchmark/oracle.ts` — deterministic stand-in, labelled as such; measures gates/retrieval/pipeline, never model quality.
- Results artifact: `benchmark/results.json` (mode + per-case results; no timestamps by design).
- Reproduce: `npm run bench` (offline) — clean checkout, no keys, no network.
- Live: `npm run bench -- --live` (requires keys) — **has never been executed; no live numbers exist and none are claimed.**

---

# Second mission addendum

- Offline result unchanged through the hardening pass: **47/50**, identical
  miss-set (b12/c03/c05), golden expectations untouched. Test suite grew to 90
  (hardening cases live in tests/hardening.test.ts, separate from the golden
  dataset and the adversarial file).
- New measured dimension: claim-coverage disclosure — deterministic-only runs
  report 0 claims checked and full runs report the extracted count; the
  "extraction completeness is not guaranteed" caveat is part of the API
  response, not just documentation.
- Provider-failure and malformed-output behavior now pinned by tests (degradation
  notes, zero fabricated compliant findings, bounded validation).
- Live-provider results still do not exist; none are claimed.
