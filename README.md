# Imprimatur

A pre-publication brand-governance review gate. Drafts are checked against an
organisation's own approved sources; every finding carries its evidence and a
six-state epistemic label; approvals are human decisions bound to the exact
content hash and recorded in a tamper-evident audit chain.

## What is in this repository

| Piece | Where | What it does |
|---|---|---|
| Normalizer | `src/lib/normalizer.ts` | sanitize (allowlist), span map, content hash (sha256 of normalized plain text) |
| Deterministic rules lane | `src/lib/rules/engine.ts` | terminology, banned phrases, puffery, injection patterns; pure functions, no network |
| Hybrid retrieval | `src/lib/retrieval/hybrid.ts` + `search_facts_hybrid()` in SQL | keyword (tsvector) + vector lanes fused with Reciprocal Rank Fusion (k=50) |
| Three verification gates | `src/lib/gates/index.ts` | closed-set citation, verbatim quote (normalized), entailment with a 0.45–0.65 uncertainty band routed to human review |
| Pipeline | `src/lib/pipeline/review.ts` | dual-lane orchestration; graceful degradation when the provider is down |
| Models | `src/lib/models.ts` | Gemini free tier primary, GLM paid fallback, schema-constrained output, confidential mode |
| Change safety | `src/lib/workflow/*` | hash-bound approvals, role gates, re-review flags on knowledge edits |
| Audit chain | `db/schema.sql` + `src/lib/audit/chain.ts` | append-only, hash-chained; UPDATE/DELETE rejected by trigger |
| Benchmark | `benchmark/` | 50 golden cases (10 rules + 18 grounding + 12 conflict/uncertainty + 10 workflow); offline oracle mode and live mode |
| Workbench | `src/app/`, `src/components/workbench.tsx` | editor, finding cards with gate detail, personas, presets, audit view |
| Demo brand | `seed/meridian-flow.ts` | fictional "Meridian Flow" knowledge base incl. one deliberately superseded fact |

## Running locally

```bash
npm install
cp .env.example .env        # fill DATABASE_URL (local Postgres or Neon); model keys optional
npm run db:push             # apply db/schema.sql
npm run db:seed             # create demo org, personas, knowledge base, drafts
npm run dev                 # http://localhost:3000
```

Sign in from the header buttons (persona one-click): password for all demo
accounts is `demo-password-1`. Without model keys the app runs in confidential
mode: deterministic findings only, and it says so.

Sessions are first-party: scrypt password hashes (`src/lib/passwords.ts`),
random 48-byte session tokens in the `session` table, httpOnly cookies, and
every workflow action re-reads the session and role server-side. (The plan
named better-auth; its postgres bridge was dropped for this small, testable
layer — a deviation disclosed here and in the Round 2 write-up.)

## Verification

```bash
npm run typecheck   # strict TS, zero errors
npm test            # 51 unit tests
npm run bench       # 50-case benchmark, offline oracle mode (no keys needed)
npm run bench -- --live   # live baseline with real providers (needs keys)
```

Offline benchmark expectations: strata A (rules) and D (change safety) pass
100%; strata B/C measure the gates and retrieval deterministically. Cases that
require live model semantics (misattributed quotes, vague hedges, synonym
attachment) are documented misses offline and are the difference between the
offline and live numbers — never mix the two modes in one report.

## Design rules this code keeps

- No finding is stored as evidence-backed unless it passed all three gates;
  gate failures demote to honest states (unsupported / unverifiable) instead
  of silent confidence.
- Uncertainty inside the 0.45–0.65 band routes to a human. It is never
  rounded into a verdict.
- Numbers and named entities carry veto power in entailment.
- Draft content is never trusted: sanitizer allowlist, injection patterns
  flagged, and the pipeline does not follow instructions found in drafts.
- The audit log is append-only at the database level; the UI can only append
  and verify.

## AI assistance disclosure

Development is AI-assisted (planning and pair programming), disclosed per the
event rules. Reused open-source components are exactly what `package.json`
lists: Next.js, React, postgres.js, zod, plus TypeScript, Vitest and tsx in
development. The database schema, pipeline, gates, benchmark and UI in this
repository were written for this event.
