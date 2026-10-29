# Imprimatur — Round 2 Submission (The Build)

Team HYV7x.0 · Hamsavarthan H (solo) · this document is the updated project
PDF content for Round 2. It is reviewed line by line against the Round 1
plan (round1-submission.html); every difference is explained, not hidden.

## 1. Functioning project link

Deployed URL: `[ADD VERCEL URL AFTER DEPLOY]` — the deployment checklist is
PRODUCTION_READINESS.md (Neon + Vercel + `db:push`/`db:seed`; the app builds
clean and its confidential surface is verified end to end in a real browser,
7/7 automated checks, e2e/e2e-smoke.mjs).

## 2. Source-code repository

github.com/hamsavartn/imprimatur — the repository contains this project with
its full verification trail (PRD, red-team audit, regression matrix,
benchmark reports). Setup for a judge: `npm install`, set `DATABASE_URL`,
`npm run db:push && npm run db:seed && npm run dev`. Without model keys the
app runs in confidential mode and says so.

## 3. The core workflow a judge can run (30 points)

One-click persona sign-in (creator / reviewer / admin) → pick a demo preset →
save → run review → findings appear with per-gate verification detail →
reviewer approves or is refused with the blocker list → audit trail verifies
the hash chain. Every step is enforced server-side; the demo journey needs no
typing beyond clicks.

## 4. Features completed (vs the Round 1 features table)

| Round 1 feature | Status in Round 2 |
|---|---|
| Brand knowledge base, versioned | DONE: versioned facts (effective/superseded), terminology + banned-phrase guidelines; CRUD via API; seeded demo brand |
| Deterministic rule engine | DONE: terminology, banned phrases, puffery, prompt-injection patterns; <300 ms, no network |
| Evidence-cited AI review, gated three ways | DONE: closed-set → verbatim quote → entailment with 0.45–0.65 human band; schema-constrained Gemini primary + GLM fallback |
| Six-state claim classification | DONE (+ one additive state, see §6) |
| Review and approval workflow | DONE: roles, rationale floor (≥15 chars), hash-bound decisions, re-review flags |
| One-click remediation (inline diffs) | NOT BUILT — see §6 for why and what exists instead |
| Accessibility and visual checks (Round 3 item) | Started early: deterministic contrast/alt/heading/link checks (advisory) |
| Change safety and tamper evidence | DONE: hash binding, append-only chained audit (SQL-verified), re-review triggers |
| Governance insights pulse strip | NOT BUILT (Round 3 scope) |
| Confidential mode and AI disclosure | DONE: zero external calls (proven by an instrumented test), banner disclosure |

## 5. Technology and implementation details

Next.js 15 App Router + TypeScript, one deployable app; Postgres/Neon with
pgvector + tsvector hybrid retrieval fused by Reciprocal Rank Fusion (k=50);
three verification gates in TypeScript; scrypt first-party sessions; 111
tests; `npm run verify` one-command pipeline; 50-case benchmark (offline
oracle mode, no keys needed). Full detail: PRD.md and README.md.

## 6. Changes from the original proposal (all explained)

1. **better-auth dropped** for a small first-party session layer (scrypt +
   DB-backed tokens): better-auth's postgres bridge failed at runtime
   (untagged-query errors in the installed version). The replacement is
   ~80 lines, fully unit-tested, and disclosed in the README.
2. **One additional finding state** (`accessibility_issue`, advisory) beside
   the six-state claim schema: accessibility findings are quality checks, not
   claim epistemics; mixing them into the six states would corrupt those
   meanings. The six-state schema for claims is unchanged.
3. **One-click remediation descoped from Round 2**: findings explain the
   problem and the required correction in text; the inline-diff apply loop is
   the Round 3 priority. The approval gate does not depend on it.
4. **ax​​e-core replaced by deterministic in-repo checks** for the
   accessibility lane: pure functions over the sanitized HTML (contrast,
   alt text, heading order, link text), measured on a planted-violation
   fixture set. A browser-based axe pass remains a Round 3 option. This
   keeps the lane runnable with zero dependencies and honest scope limits
   (no focus-order/ARIA auditing — stated wherever results appear).
5. All planning work was done inside the Round 1 window, as submitted.

## 7. The three improvements named for Round 3 (unchanged, measured baselines attached)

1. **Hybrid retrieval + the three verification gates** — baseline already
   exceeds the target: evidence recall@5 = **18/18 (100%)** on the benchmark's
   retrieval-checked cases (target ≥0.90); zero fabricated citations admitted
   by construction (a model-authored citation cannot be stored evidence-backed
   without passing all three gates — pinned by adversarial tests including a
   judge forced to answer 0.99).
2. **Deterministic accessibility and visual inspection** — baseline on the
   planted-violation fixture: **100% recall, 100% precision (19 violations)**
   (targets ≥91.7% / ≥95%). Scope: deterministic checks on inline styles and
   structure; browser-level audits remain out of scope and are labelled so.
3. **Change safety** — baseline: post-approval edits and unauthorised
   approvals are blocked server-side (hash mismatch and role gates, pinned by
   tests); tamper-evident audit chain with SQL verification. Round 3 adds the
   certificate artifact (built: JSON + printable) and the inline remediation loop.

## 8. My role and the part I built (the two lines the certificate prints)

Role: built everything on this team, the plan and the execution, with AI
assistance as disclosed in my proposal.
Part built: the complete plan and the complete product, from the research and
architecture to the verification gates, the approval workflow, the evaluation
benchmark, deployment and documentation.

## 9. What is honestly not done

Live-database verification (triggers, sessions, multi-org) is written and
reviewed but executes only at deployment (no Postgres available on the build
machine — BLOCKED, documented); deployment itself; live-model benchmark
baseline (no API keys used); inline remediation; governance pulse strip.
Every claim in this document is backed by a test, a report, or an explicit
BLOCKED marker in REGRESSION_MATRIX.md.
