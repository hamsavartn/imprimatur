# Final Engineering Summary — Imprimatur

## Files changed (this mission)

| Area | Files |
|---|---|
| Gates (core repairs) | `src/lib/gates/index.ts` — semanticCap() (shared caps: numbers, negation incl. contractions, modality, bound direction + overclaim scoping, antonyms, hedges); per-segment Gate 2; judge clamped by caps and verdict routed on clamped confidence |
| Workflow | `src/lib/workflow/approval.ts` — approvalBlockers() server-side policy |
| Schema | `db/schema.sql` — advisory-lock serialized audit inserts; audit_verify_chain() SQL function; human_review added to finding CHECK |
| Routes | approve (policy + validation + degraded disclosure), drafts GET/review (org checks), drafts POST (ownership check), audit (SQL verification), review (format namespace fix: markdown) |
| Repo | `src/db/repo.ts` — getDraft org field, reviewStatusForHash (latest run only), org-scoped upsert |
| Tests | `tests/adversarial.test.ts` — NEW, 26 cases |
| Docs | PRD.md, RED_TEAM_AUDIT.md, SECURITY_AND_TRUST_CASES.md, PRODUCTION_READINESS.md, BENCHMARK_REPORT.md, HACKATHON_DEMO.md, this file |

## Defects fixed

17 total across two passes (F1–F9 implementer pass; R1–R7 + refinements from the
independent reviewer, who found defects in the first pass's own fixes — the
number veto not binding the judge, and an over-firing bound cap). Full detail
with reproductions: RED_TEAM_AUDIT.md.

## New features implemented

- Server-side approval policy (blockers + latest-run + lane disclosure)
- SQL-side audit chain verification (`audit_verify_chain()`)
- Adversarial regression suite as a permanent gate

## Tests added and executed

26 adversarial cases; suite grew 55 → **81/81 passing**. Typecheck strict clean.
Production build clean. Benchmark stable at **47/50 offline** with golden
expectations untouched (identical miss-set to pre-audit: b12/c03/c05).

## Deployment status

Not deployed. Git untouched (owner pushes). Live DB bring-up **BLOCKED** on this
machine (no Postgres/Docker); the deployment-time verification checklist is in
PRODUCTION_READINESS.md, and the demo script has a rehearsed provider-down fallback.

## Unresolved blockers

1. Live Postgres execution of: audit triggers, advisory lock, verify function, re-review triggers, org isolation, cookie sessions, concurrent approvals.
2. Live-provider benchmark baseline (no keys used; none claimed).

## Residual risks (accepted, documented)

- Audit chain is tamper-evident, not tamper-proof against the DB owner (no external head anchor yet).
- Lexical caps are heuristics; over-routing to human review is the accepted cost (known case: antonym-word pairs on compatible statements).
- Approval during a degraded review is disclosed, not blocked (confidential mode is legitimate).
- `.env.example` carries two vestigial BETTER_AUTH_* vars from the removed dependency.

## Verdict

**Hackathon readiness: strong.** The differentiating claim — no model-authored
finding reaches a reviewer uncertified, and no approval survives a silent edit —
is now enforced in code, attacked by two independent passes, and pinned by 26
adversarial tests; the failure modes we could execute, we executed.

**Production readiness: not yet.** The honest line is: engine verified offline
end to end; service-level behavior (database, deployment, live models) remains
unverified and is the first thing to do at deployment. Nothing in the docs
claims otherwise.

---

# Second mission — final addendum

## Changes

- `scripts/verify.mjs` + `npm run verify`: one-command pipeline (env, typecheck,
  90 tests, benchmark, build, audit report, secret scan; BLOCKED stages explicit).
- `src/lib/models.ts`: parseBounded() — raw-size gate (256k) + per-paragraph
  claims cap (50) on every model-output parse (zod exhaustion advisory mitigated
  without a breaking upgrade).
- `src/lib/pipeline/review.ts` + review route: claimsExtracted coverage field
  and the coverageNote disclosure ("extraction completeness is not guaranteed").
- `src/lib/validate.ts` + drafts route: 413 payload/title limits.
- `e2e/e2e-smoke.mjs`: real-browser confidential-surface smoke — EXECUTED, 7/7.
- Tests 81 → **90/90**; benchmark stable at **47/50** (golden untouched).
- Docs: REGRESSION_MATRIX.md (defect/invariant → test map with execution
  status), RELEASE_DEMO.md (replaces HACKATHON_DEMO.md), audit addenda.

## Defects found and fixed this pass

H1 model-output OOM vector (HIGH), H2 silent claim omission (MEDIUM),
H3 unproven zero-network promise (MEDIUM, now proven by instrumented test),
H4 unbounded payloads (MEDIUM), H5 malformed-output degradation (LOW, pinned).

## Second-pass independence note

An independent reviewer agent was dispatched for this delta; the dispatch was
interrupted in transit and is being re-run. Its verdict, defects (if any), and
repairs will be recorded here. Limitation if it cannot complete: the second
pass is then an additional self-challenge, not fully independent assurance —
stated plainly rather than claimed away.

## Commands executed and results

npm run verify → all executable stages PASS; npm audit (2 high dispositioned);
node e2e/e2e-smoke.mjs → 7/7; npm test → 90/90; npm run bench → 47/50;
npx tsc --noEmit → 0 errors; next build → clean.

## Release-readiness verdict

Unchanged in substance, stronger in evidence: the trust core is now defended
by 90 tests including zero-network and bounded-validation proofs, the product
no longer implies full-document verification, the pipeline is one command, and
the confidential surface is verified in a real browser. Production readiness
still requires the blocked DB bring-up, deployment, and live benchmark.

---

# Third pass addendum (independent review of hardening + Round 3 delta)

Independent reviewer verdict: DEFECTS FOUND (10) — including two that had
gutted the new accessibility feature end to end (img preservation no-op,
contrast scanner starved of styles by the sanitizer). All 10 reproduced,
repaired, regression-pinned; the measurement dataset absorbed every
counterexample and now pins exact numbers (19/19, 100%/100%). Final state:
111/111 tests, benchmark 47/50 (pipeline-enforced), clean build, E2E 7/7.
Both submission documents (ROUND2_SUBMISSION.md, ROUND3_SUBMISSION.md) were
written against the Round 1 plan's exact commitments, with every deviation
explained and every unmet target disclosed rather than reworded.
