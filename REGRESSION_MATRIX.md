# Regression Matrix — Imprimatur

Every confirmed defect and every PRD contractual invariant, mapped to the test
that verifies it, with actual execution status. Commands: `npm test` (all
rows marked EXECUTED), `npm run bench`, `npm run verify`, `node e2e/e2e-smoke.mjs`.

Status legend: EXECUTED (ran and passed on this machine) · BLOCKED (requires
live PostgreSQL/keys) · DB (schema-level assertion, execution needs a database).

## Defect → test map

| Defect (RED_TEAM_AUDIT.md) | Invariant | Test file · case | Status |
|---|---|---|---|
| F1 negation blindness | 3, 4 | adversarial.test.ts · "claim asserting what the source denies" | EXECUTED |
| F1b modality blindness | 3 | adversarial.test.ts · "assertion over a hedged source" | EXECUTED |
| F1c bound-direction blindness | 3 | adversarial.test.ts · quantity-bound minimal pairs (up-to/at-least/no-more-than) | EXECUTED |
| F2 stitched quotes (Gate 2) | 1 | adversarial.test.ts · Gate 2 quote stitching (3 cases) | EXECUTED |
| F3 verifier/trigger hash divergence | 7 | db/schema.sql · audit_verify_chain() | DB (BLOCKED) |
| F4 no server-side approval policy | 5, 10 | adversarial.test.ts · server-side approval policy (3 cases); route logic | EXECUTED + DB pending |
| F5 IDOR on draft routes | 8 | route ownership checks (GET/review/approve/POST) | DB pending (code reviewed ×2) |
| F6 audit-chain fork under concurrency | 7 | db/schema.sql · pg_advisory_xact_lock | DB (BLOCKED) |
| F7 hash-namespace split (markdown vs html) | 5 | normalizer.test.ts format-independence cases + review route single-format fix | EXECUTED + DB pending |
| F8 human_review violates CHECK | 12 | db/schema.sql · finding CHECK | DB (BLOCKED) |
| F9 silent degraded approval | 10, 11 | approve route lane disclosure | DB pending |
| R1 number veto ≠ judge clamp | 2 | adversarial.test.ts · R1, R1b (judge 0.99 cannot comply wrong numbers) | EXECUTED |
| R2 contraction blindness (can't/won't) | 3 | adversarial.test.ts · R2, R2b | EXECUTED |
| R3 equal-count polarity flip | 3 | adversarial.test.ts · R3 ("not disabled"/"not enabled") | EXECUTED |
| R4 point-over-bound overclaim | 3 | adversarial.test.ts · R4 | EXECUTED |
| R5 number-format false vetoes | 3 | adversarial.test.ts · R5, R5b (provider-independence) | EXECUTED |
| R6 resolved dead code / stale blockers | 6 | reviewStatusForHash latest-run-only + approval tests | EXECUTED + DB pending |
| R7 decision-verb validation / revoke order | 10 | approve route logic | DB pending |
| Hardening: model-output OOM (zod advisory) | — | hardening.test.ts · bounded validation (size gate, claims cap ≤50) | EXECUTED |
| Hardening: silent claim omission | 14 | hardening.test.ts · claim-coverage disclosure (2 cases) + review route coverageNote | EXECUTED |
| Hardening: confidential zero-network | 9 | hardening.test.ts · fetch-instrumented zero-call proof (2 cases) | EXECUTED |
| Hardening: oversized payloads | — | hardening.test.ts · payload limits + route 413 paths | EXECUTED + DB pending |
| Hardening: malformed provider output | 10, 11 | hardening.test.ts · garbage-JSON degradation | EXECUTED |

## Invariant → evidence map (PRD contractual invariants 1–14)

| # | Invariant | Primary evidence | Status |
|---|---|---|---|
| 1 | Evidence = identity + verbatim quote | gates.test.ts, adversarial.test.ts (Gate 1/2 suites) | EXECUTED |
| 2 | LLM cannot override identity/quote gates | adversarial.test.ts · gate-order integrity (judge 0.99) | EXECUTED |
| 3 | Support/contradiction/uncertainty/missing distinguished | gates.test.ts + adversarial minimal pairs | EXECUTED |
| 4 | 0.45–0.65 routes to human (boundary-tested) | gates.test.ts · band edges 0.4499/0.45/0.6499/0.65 | EXECUTED |
| 5 | Approval binds to reviewed content | chain.test.ts + normalizer hash tests + route logic | EXECUTED + DB pending |
| 6 | Knowledge change flags decisions | chain.test.ts · flagsFor cases + DB trigger | EXECUTED + DB (BLOCKED) |
| 7 | Append-only, verifiable audit chain | chain.test.ts (JS) + schema.sql (SQL, BLOCKED) | PARTIAL |
| 8 | Server-side authn/authz on privileged ops | session tests + route checks + e2e 401 assertion | EXECUTED + DB pending |
| 9 | Confidential mode = zero external calls | hardening.test.ts · fetch-instrumented proof | EXECUTED |
| 10 | Provider failure never yields compliant | adversarial.test.ts · provider-down suite | EXECUTED |
| 11 | Deterministic checks always usable | adversarial.test.ts + e2e smoke (live confidential run) | EXECUTED |
| 12 | Six states + human_review semantics | states.ts + CHECK constraint + benchmark strata B/C | EXECUTED + DB (BLOCKED) |
| 13 | Retrieval/workflow/persistence consistency | rrf.test.ts + benchmark evidence recall@5 (B strata) | EXECUTED + DB pending |
| 14 | No false "fully checked" claim | hardening.test.ts coverage cases + route coverageNote | EXECUTED |

## Aggregate execution status (from `npm run verify`)

PASS: environment · typecheck · 90 tests (incl. all EXECUTED rows above) · offline
benchmark 47/50 · production build · secret scan. REPORTED: dependency audit
(dispositions in PRODUCTION_READINESS.md). BLOCKED: DB integration, DB
concurrency, DB-backed route behavior, production runtime smoke. EXECUTED
separately: E2E browser smoke 7/7 (confidential surface). NOT RUN: lint
(no linter configured).
