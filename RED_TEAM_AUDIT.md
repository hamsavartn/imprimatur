# Red-Team Audit — Imprimatur

## Executive summary

Two adversarial passes were run against the implementation: the implementer's own
red-team pass (Phase 1–6 of the mission), then an **independent reviewer agent**
given the PRD, the diffs and test evidence, and explicit permission to disagree —
it did, finding **9 defects, several in the implementer's own fixes**. All 9 were
reproduced where reproducible offline, repaired, and pinned by regression tests.
Final state: 81/81 unit tests (26 adversarial), 47/50 offline benchmark
(same 3 documented live-semantics misses as the pre-audit baseline — no golden
expectation was altered), strict TypeScript clean, production build clean.

## Actual baseline (reproduced, not trusted)

| Claim | Reproduced result |
|---|---|
| tsc strict clean | ✅ exit 0 |
| 55 unit tests pass | ✅ 55/55 |
| offline benchmark 47/50 | ✅ 47/50, misses b12/c03/c05 |
| clean production build | ✅ 0 errors |
| runtime smoke | ✅ /api/status honestly reports confidential mode; unauth'd /api/drafts refused; page renders |
| live DB bring-up | ❌ **BLOCKED**: no psql, no Docker on this machine; pgvector required |

## Threat model

Attacker = insider or API client trying to (a) get an unsupported claim stored as
evidence-backed, (b) approve content that was never properly reviewed, (c) quietly
rewrite history, (d) access another organisation's drafts, (e) smuggle instructions
through draft or source text. Model = semi-trusted: it proposes, gates dispose.

## Requirements-to-implementation matrix (post-repair)

| PRD invariant | Implementation | Evidence |
|---|---|---|
| 1 Evidence or honesty | 3 gates in code; gate-order integrity pinned by tests with a judge at 0.99 | tests/adversarial.test.ts |
| 2 Uncertainty surfaced | [0.45,0.65) routes to human; clamped confidence routes the verdict | gates.test.ts, adversarial R-cases |
| 3 Approval bound to SHA-256 | hash from one normalizer used by BOTH save and review (defect 7 fixed) | adversarial tests + code inspection |
| 4 Append-only audit | UPDATE/DELETE raise; hash recomputed and verified in SQL | schema.sql audit_verify_chain() |
| 5 Untrusted drafts | allowlist sanitizer + injection patterns; never followed | rules tests |
| 6 Confidential mode | zero external calls, disclosed in UI and API | runtime smoke |
| 7 Deterministic lane always available | provider-down test pins degradation + no fabricated findings | adversarial test |
| 8 Facts versioned | supersede-on-write + superseded-citation → sources_conflict | gates tests |
| 9 Knowledge changes flag content | flags predicate + DB trigger | chain.test.ts |
| 10 Server-side decisions | role gates + approval policy enforced in route, not UI | approval tests |
| 11 Rationale floor | ≥15 chars enforced in recordDecision | approval tests |
| 12 Six states + human_review | CHECK constraint extended to include human_review (defect F8 fixed) | schema.sql |

## Findings (all REPRODUCED DEFECT unless noted; all repaired)

| # | Severity | Finding | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| F1 | P0 | "The product supports offline mode" over "does not support" = `entailed` | lexical scorer counted tokens, blind to negation | semantic guard rails shared by lexical AND judge paths | adversarial minimal pairs |
| F1b | P0 | modality: "reduces costs" over "may reduce costs" = `entailed` | same | modality cap 0.6 | adversarial |
| F1c | P0 | "up to 50" over "50 concurrent" = `entailed`; opposite bound directions uncapped | no bound semantics | bound-direction caps; overclaim cap fires only when the claim's number is the bounded number (first cut over-fired — fixed) | adversarial |
| F2 | P0 | Gate 2 accepted a quote stitched across sourceQuote+statement | substring over the JOIN | per-segment matching | adversarial stitched-quote cases |
| F3 | P0 | JS verifier could never validate DB rows (ISO vs timestamptz::text, JSON vs jsonb::text spacing) | two hash serializations | verification moved INTO SQL with the trigger's own expressions; JS verifier documented as offline-only | schema inspection |
| F4 | P0 | approval route had NO server-side blocking-findings policy | policy lived (partly) in UI | approval requires latest completed review at current hash, zero unresolved blockers; response/audit disclose lane | approval policy tests |
| F5 | P0 | draft GET/review/approve lacked org-ownership checks (IDOR); reviewer then found POST /api/drafts upsert **still** lacked it | authz added per-route, missed one | all draft routes check org; UPDATE carries org_id predicate; route 404s first | code inspection (DB-dependent parts untestable offline) |
| F6 | P1 | concurrent audit inserts chain off the same row → fork | no serialization | pg_advisory_xact_lock in the insert trigger | schema inspection (needs live DB to execute) |
| F7 | P1 (bricks workflow) | save hashed markdown-normalized text; review hashed html-normalized text → approval ALWAYS 409 "no completed review" for multi-line drafts | two format namespaces | review route normalizes with the saved format (markdown); single source of truth documented | code inspection; offline hash tests pin format-independence of the plain hash |
| F8 | P1 | `human_review` findings violated the finding CHECK constraint → any uncertain claim crashed review persistence | constraint predated the routing outcome | CHECK extended | schema inspection |
| F9 | P1 | approval succeeded on a degraded (deterministic-only) review with zero claims checked | lane not consulted | lane recorded in approval audit + explicit warning in response; residual: not hard-blocked (confidential mode is a legitimate mode) | code inspection |
| R1 | P0 (reviewer) | **number veto did not bind the model judge**: $59 claim + $49 quote + judge 0.99 = `compliant` | clamp used semanticCap which lacked number logic | number veto moved into shared semanticCap; verdict routes on CLAMPED confidence | adversarial R1, R1b |
| R2 | P0 (reviewer) | `can't`/`don't`/`won't` slipped the negation cap (`\bn't\b` needs a boundary) | regex boundary bug | NEGATION regex `n't\b` without leading boundary | adversarial R2, R2b |
| R3 | P1 (reviewer) | equal negation counts, opposite polarity ("not disabled" vs "not enabled") = `entailed 0.8` | counts, not polarity | both-negated pairs cap to 0.6 (human band) | adversarial R3 |
| R4 | P1 (reviewer) | point claim over bounded source ("supports 100" over "up to 100") = `entailed 0.95` | asymmetry uncapped | overclaim cap, scoped to the bounded number (naive version false-blocked $49-vs-"up to 3" — fixed via number intersection) | adversarial R4 + benchmark stability |
| R5 | P1 (reviewer) | "1,000" vs "1000" and "$49.00" vs "$49" false-vetoed; verdicts differed by provider availability | comma/decimal fragments became phantom mismatched numbers | normalized number sets (extractNumbers + word-number map); oracle uses the same | adversarial R5, R5b |
| R6 | P1 (reviewer) | `resolved` was dead code; findings accumulated across runs → one old blocking finding blocked approval forever | reviewStatusForHash unioned all runs | policy uses the LATEST completed run only | code inspection + approval tests |
| R7 | P1 (reviewer) | approve route's "re-checks live row" comment was false; malformed decision verb could revoke before failing | same-variable comparison; no validation | comment corrected to the real guarantee (downstream hash equality); decision validated before any state change; revoke reordered after insert | code inspection |

## Confirmed vs unverified risks

- **VERIFIED (executed):** all gate-level defects above; all route-level logic reachable without a DB; hash instability classes; benchmark integrity.
- **UNVERIFIED (BLOCKED, needs live Postgres + pgvector):** trigger execution (advisory lock, write-blocking, chain verification), tenant isolation against a second org, session cookie behavior end-to-end, concurrent-approval races, re-review trigger firing. The SQL is written and reviewed but never executed — this is the single biggest open risk and it is visible, not hidden.
- **Residual, accepted:** a DB superuser can TRUNCATE audit_log and re-insert a forged chain (hash inputs are public; there is no external head anchor). Tamper-EVIDENT for app-level actors, not tamper-PROOF against the DB owner. Periodic external checkpoint of the head hash is the scoped hardening path (documented, not built).
- **Residual, accepted:** lexical caps are heuristic, not calibrated probabilities; `audit_verify_chain()` timezone sensitivity (trigger and verifier should run under the same session TimeZone — noted for deployment).

---

# Second mission — hardening pass (independent verification pipeline)

A second adversarial mission re-established the baseline (81/81, 47/50, clean
build — all reproduced) and attacked surfaces the first pass had not:

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| H1 | HIGH | zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5) is IN our threat model: model output is zod-parsed and a hostile provider response could OOM the extraction stage | parseBounded(): raw-text gate (256k) before parse + per-paragraph claims cap (50); applied to extraction AND entailment paths | hardening.test.ts |
| H2 | MEDIUM | the system could present itself as fully verified while the extractor silently omitted claims (no completeness guarantee was disclosed) | ReviewResult.claimsExtracted + route coverageNote ("extraction completeness is not guaranteed"); audit records the count | hardening.test.ts |
| H3 | MEDIUM | confidential mode's zero-network promise was asserted, never proven | fetch-instrumented test proves ZERO calls through extraction, entailment and embedding in confidential mode | hardening.test.ts |
| H4 | MEDIUM | POST /api/drafts accepted unbounded payloads (DoS surface) | 413 on drafts >200k chars, titles >300 chars | hardening.test.ts |
| H5 | LOW | malformed provider JSON: verified the degradation path skips only the failing paragraph, keeps deterministic findings, and cannot fabricate compliance | already correct; now pinned by test | hardening.test.ts |

Dependency audit (npm audit --omit=dev): postcss-via-next (high, build-time
attack surface only — no user CSS path at runtime; only fix is a breaking
next@16 major upgrade, rejected pre-demo per change-control) and zod (high,
MITIGATED in code by H1 without the breaking 4.x upgrade). Both dispositioned
in PRODUCTION_READINESS.md.

New verification infrastructure: `npm run verify` (single pipeline: env →
typecheck → tests → benchmark → build → audit report → secret scan, with
explicit BLOCKED/NOT RUN stages that cannot convert into passes) and
`e2e/e2e-smoke.mjs` (real-browser confidential-surface smoke, 7/7 executed:
title, mode disclosure, preset load, server-side 401, honest sign-in demand).

Test totals moved 81 → 90; benchmark unchanged at 47/50 with golden
expectations untouched. Independent second-pass review of THIS delta was
attempted via a separate reviewer agent (see FINAL_ENGINEERING_SUMMARY.md for
its outcome and any limitations).

---

# Third pass — independent review of the hardening + Round 3 delta

A second independent reviewer agent (fresh dispatch, adversarial brief,
scratch-script reproduction) examined the bounded-validation work, the
accessibility lane, certificate routes and the verification pipeline:

**DEFECTS FOUND: 10 — all reproduced, all repaired, all pinned by tests.** The
two most consequential: the sanitizer's img-preservation was a **no-op** (the
generic attribute-stripper immediately re-stripped src/alt, breaking the a11y
lane), and **style attributes never survived sanitization**, making the
contrast scanner dead code in the only way the pipeline runs it — the
100%/100% measurement had been taken on HTML the pipeline never feeds it.
Also fixed: an event-handler escape hatch (`<a href=x onerror=...>` survived
via the href lookahead), data:/vbscript: hrefs, unescaped alt values,
backwards color inheritance (innermost must win), rgba-alpha handling,
img-in-link discernible names, dead aria-label escape, silent claims-cap
truncation, the parse gate sitting after body materialization, gate-3
negative-direction routing contradicting its own docs, a non-monotonic
confidence floor, verify.mjs stages that could not fail (benchmark score now
ENFORCED at the committed baseline; secret patterns fixed for sk-proj- keys;
grep failure no longer conflated with no-match), certificate cross-tenant
chain scope (documented as global by design), and the payloads materialized
before size checks (content-length gate added).

The planted-violation dataset now includes every counterexample the reviewer
constructed, and the assertions pin exact numbers: **19 planted, 19 caught,
recall 100%, precision 100%** (a regression fails the suite; an improvement
requires a deliberate file update). Sanitizer attack cases (handler forms,
scheme smuggling, quote escapes) are pinned in tests/normalizer.test.ts.

Test totals: 90 → **111/111**. Benchmark: 47/50 unchanged, now ENFORCED by
the pipeline. E2E smoke: 7/7 on a fresh server.
