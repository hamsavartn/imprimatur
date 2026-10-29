# Imprimatur — Round 3 Submission (The Finish)

Team HYV7x.0 · Hamsavarthan H (solo). This document is the final project PDF
content: complete feature list, architecture summary, the three improvements
delivered and measured against exactly what was named in Round 2, testing
details, roadmap, and the honest list of what remains.

## 1. Final working project link and repository

Deployed URL: `[ADD FINAL VERCEL URL]` · Repository:
github.com/hamsavartn/imprimatur. Judge setup: `npm install`, set
`DATABASE_URL`, `npm run db:push && npm run db:seed && npm run dev`. The
production build compiles clean and the confidential surface passes its
automated browser journey (7/7).

## 2. Complete feature list

**Review engine**
- Dual-lane pipeline: deterministic lane (terminology, banned phrases,
  puffery, prompt-injection patterns, accessibility checks) always runs;
  grounding lane (claim extraction → hybrid retrieval → three verification
  gates) degrades gracefully and discloses when the provider is unavailable
- Six-state claim epistemics (contradicts_fact / unsupported / unverifiable /
  sources_conflict / promotional_puffery / compliant) + human_review routing
  (0.45–0.65 band) + advisory accessibility_issue
- Hybrid retrieval: Postgres tsvector + pgvector fused with RRF (k=50);
  evidence recall@5 = 100% on the benchmark's retrieval-checked cases
- Model gateway: Gemini primary, GLM paid fallback, schema-constrained
  output, per-stage timeouts, bounded-validation against hostile responses,
  confidential mode with a test-proven zero-network guarantee

**Workflow and trust**
- Role-gated review workflow (creator / reviewer / admin), server-side
  approval policy (completed review at the current hash, no unresolved
  blocking findings), rationale floor
- Approvals bound to the SHA-256 of the normalized content; any edit
  invalidates them, enforced server-side
- Versioned facts with supersede/expiry; knowledge changes flag affected
  approved drafts for re-review (database trigger + tested predicate)
- Append-only hash-chained audit log (UPDATE/DELETE rejected by triggers,
  concurrent appends serialized, chain verified inside SQL)

**Product surface**
- Workbench UI: persona switcher, demo presets, finding cards with per-gate
  detail, audit viewer, honest mode/degradation/coverage banners
- Compliance certificate (Round 3 improvement 3): machine-checkable JSON
  artifact + printable page, stating exactly what it does and does not prove
- Deterministic accessibility lane (Round 3 improvement 2)

## 3. Architecture and implementation summary

Full architecture, directory tree, stack reasoning and security model:
PRD.md. Short form: one Next.js app + one Postgres; the trust core (gates,
hash binding, audit chain) is deterministic TypeScript and SQL, never inside
a model; the model proposes, the gates dispose; uncertainty routes to humans.

## 4. The three improvements — measured against exactly what was named in Round 2

| Named in Round 2 (and Round 1 before it) | Target | Delivered | Measured result |
|---|---|---|---|
| 1. Hybrid retrieval + three verification gates | zero fabricated citations admitted; evidence recall@5 ≥ 0.90 | both built; gates enforce citation identity, verbatim quotes and entailment with number/negation/modality vetos; adversarial tests include a judge forced to 0.99 attempting bypass | **recall@5 = 18/18 (100%)**; zero fabricated citations stored evidence-backed across 111 tests + 50 benchmark cases |
| 2. Deterministic accessibility and visual inspection | ≥ 91.7% of planted violations caught, precision ≥ 95% | deterministic lane over sanitized HTML: WCAG contrast (incl. large-text rule), img alt, heading order, link text | **recall 100%, precision 100% on 19 planted violations** (exact-pinned test; deterministic scope honestly limited — no browser-level ARIA/focus auditing, labelled everywhere) |
| 3. Change safety | ten-violation draft remediated < 30 s; 100% blocking of post-approval edits and unauthorised approvals | hash-bound approvals, role gates, tamper-evident chain, re-review flags, certificates | 100% blocking (structural, server-side, pinned by tests). The < 30 s remediation number is NOT claimed: the inline-diff apply loop was descoped (see Round 2 document §6) — the certificate + re-review flow exists, the one-click diff does not |

## 5. Testing details

- **111 automated tests** (Vitest): normalizer/security, deterministic rules,
  all three gates + minimal-pair adversarial cases, RRF retrieval, audit
  chain tamper detection, approval workflow, accessibility unit +
  planted-violation measurement, hardening (zero-network, bounded
  validation, payload limits, malformed-provider degradation)
- **50-case golden benchmark** (offline oracle): 47/50; the 3 misses are the
  documented cases requiring live-model semantics; golden expectations were
  never altered across two full audit passes
- **One-command pipeline**: `npm run verify` (env → typecheck → tests →
  enforced benchmark score → build → dependency-audit report → secret scan;
  DB/E2E stages print BLOCKED with prerequisites rather than passing silently)
- **E2E browser smoke**: 7/7 (real Chromium against the dev server)
- **Two independent adversarial passes**: an independent reviewer agent found
  9 defects in the first implementation pass (including flaws in that pass's
  own fixes) and 10 more in the second pass (including a no-op sanitizer
  feature and a dead contrast scanner) — all reproduced, repaired, and pinned
  by regression tests. Full trail: RED_TEAM_AUDIT.md + REGRESSION_MATRIX.md
- **Blocked, not faked**: live-database trigger execution, multi-org
  isolation and live-model accuracy require infrastructure not available on
  the build machine; they are the first items in PRODUCTION_READINESS.md

## 6. Reliability under normal use

Hostile input (injection patterns, oversized payloads, malformed provider
output — bounded and degraded with disclosure), empty states (no review yet,
no findings, unapproved certificates), repeated actions (idempotent review
runs; repeat submissions create new runs, approvals are hash-gated), provider
failure (deterministic lane continues, mode disclosed), stale decisions
(editing blocks old approvals). Known cosmetic gaps are listed in
PRODUCTION_READINESS.md rather than hidden.

## 7. Product roadmap and future development plan

ROADMAP.md: deployment-adjacent work (live bring-up, resolution workspace,
certificate signing + public verification endpoint), then ingestion (DOCX/PDF),
knowledge-base experience, editor plug-ins, browser-level accessibility depth,
multi-team tenancy — each sequenced by dependency, with explicit non-goals.

## 8. My role and the part I built (the two lines the certificate prints)

Role: built everything on this team, the plan and the execution, with AI
assistance as disclosed in my proposal.
Part built: the complete plan and the complete product, from the research and
architecture to the verification gates, the approval workflow, the evaluation
benchmark, deployment and documentation.

## 9. What is left undone, said plainly

Live-database execution of the database-level guarantees (BLOCKED on this
build machine — the SQL is written, reviewed twice, and executes at
deployment), deployment and the live-model benchmark baseline (no API keys
were used; offline and live results are never mixed), the one-click
inline-diff remediation loop (descoped; explained in the Round 2 document),
governance pulse strip, and browser-level accessibility auditing beyond the
deterministic lane.
