# Imprimatur — Product Requirements Document

Imprimatur is a brand-governance review gate. It sits between the people who
write content and the publish button, checks every factual claim in a draft
against the organisation's own approved sources, and makes the result
impossible to fake quietly: findings carry their evidence, approvals bind to
the exact text that was reviewed, and every action lands in a tamper-evident
audit trail.

This document explains the product for a reader who has never heard of the
event it was built for: the problem, the users, how the system works, what
exists today, and what is planned.

---

## 1. The problem

Organisations publish constantly: landing pages, release notes, social posts,
campaign emails. The facts inside that content (prices, product names,
statistics, capabilities, dates) live somewhere official, but the people
writing rarely check against them, and the people approving do it from
memory. The result is content drift: a price that changed last quarter still
in the footer, a discontinued feature still listed, a claim someone wrote
optimistically in a launch email now quoted back by a customer.

Existing tools split into two camps, and neither one closes this loop:

- **Writing assistants** (grammar and tone checkers, AI writing copilots)
  help the person who is typing. They judge style, not truth against the
  company's own sources.
- **Brand portals and asset libraries** store guidelines and approved
  wording, but nothing examines finished content against them. The library
  is a reference, not a gate.

What is missing is the step at the end: examine the finished draft, whatever
produced it, against the organisation's own approved sources, right before
it goes out, and produce evidence a human can act on. That step is
Imprimatur.

A second problem shows up as soon as anyone tries to build that step with a
language model: models fabricate. Asked "is this claim supported?", a plain
LLM will happily invent a plausible source, paraphrase a quote that was never
written, or answer confidently when it has no idea. Imprimatur's core design
constraint is that **no finding is stored as evidence-backed unless it
survived a mechanical verification that a model cannot talk its way past.**

## 2. Who it is for

- **Content creators** (marketing writers, founders, anyone producing
  outward-facing material). They want to know what is wrong before their
  reviewer finds it, and they want findings that explain themselves rather
  than a red squiggle.
- **Reviewers and approvers** (team leads, brand owners, compliance-adjacent
  roles). They are accountable for what ships. They need the source behind
  every flagged claim, in one click, and a defensible record of what they
  approved and when.
- **Small teams first.** Teams large enough to publish regularly but too
  small for a dedicated brand-compliance role, where one person wearing that
  hat part-time is the current "system".

## 3. Product principles

These are invariants, not aspirations. Each one is enforced in code and
covered by tests.

1. **Evidence or honesty.** A finding either carries a verified source and a
   verbatim quote, or it is labelled with what is missing (unsupported,
   unverifiable). There is no confident middle state.
2. **Uncertainty is surfaced, never rounded.** When entailment confidence
   lands between 0.45 and 0.65, the claim routes to a human reviewer. The
   system does not guess to avoid bothering anyone.
3. **Approval belongs to the exact text.** Approvals bind to a SHA-256 hash
   of the normalised draft. Any edit afterwards invalidates them, enforced
   server-side.
4. **The audit trail cannot be quietly edited.** The log is append-only at
   the database level (UPDATE and DELETE raise exceptions) and each row's
   hash chains to the previous row. Tampering with history breaks the chain
   visibly.
5. **Drafts are untrusted input.** Content is sanitised against an allowlist,
   prompt-injection patterns inside drafts are flagged, and the pipeline
   never follows instructions found in draft text.
6. **It works when the AI is down.** The deterministic lane runs with zero
   external services. Provider outages degrade the product gracefully and
   visibly, never silently.

## 4. How a review works

### 4.1 The two lanes

Every review runs two independent passes over the draft.

**The deterministic lane** (always runs, no network):

- Terminology rules: must-avoid spellings and aliases mapped to the approved
  term ("MeridianFlow" and "MF Platform" -> "Meridian Flow").
- Banned phrases (e.g. outcome guarantees the brand does not make).
- Promotional puffery patterns: superlatives, absolute claims, unfalsifiable
  universals ("everyone knows...", "never fails").
- Prompt-injection detection: instruction-override and persona-hijack
  patterns inside the draft itself.
- WCAG contrast arithmetic (exposed as a function; the UI integration is
  planned).

**The grounding lane** (needs a model provider; skipped honestly in
confidential mode):

1. The draft is split into paragraphs; a schema-constrained model call
   extracts checkable factual claims (numbers, names, dates, capabilities)
   with their character offsets. Tone and grammar are explicitly out of
   scope.
2. For each paragraph, hybrid retrieval pulls candidate sources: a keyword
   lane (Postgres full-text) and a vector lane (pgvector embeddings), fused
   with Reciprocal Rank Fusion (k = 50). Keyword matters disproportionately
   here because brand claims live and die on exact product codes and clause
   numbers, which vector search handles poorly.
3. Every extracted claim that cites a source must pass three gates
   (section 4.2). Claims that cite nothing become "unsupported" findings,
   which is the correct output for a claim the knowledge base cannot back.

### 4.2 The three verification gates

A model-proposed finding is only stored as evidence-backed if it passes all
three. Any failure demotes it to an honest state.

| Gate | Question | Mechanism | On failure |
|---|---|---|---|
| 1. Closed set | Is the cited source one of the organisation's approved facts? | Lookup by fact id (or key) in the approved set only | `unsupported` |
| 2. Verbatim quote | Does the claimed supporting quote actually appear in that source? | Normalised substring check (case, punctuation, quote marks, whitespace); quotes that skip a word fail | `unverifiable` |
| 3. Entailment | Does the source actually support the claim? | Deterministic lexical check first (numbers and named entities carry veto power: one mismatched number caps confidence); a model-based judge refines inconclusive cases; the 0.45 to 0.65 band routes to a human | `contradicts_fact`, `unsupported`, or human review |

One more rule sits between the gates and the verdict: if the matched fact is
a **superseded version** (the organisation has since replaced its wording),
the finding becomes `sources_conflict` regardless of entailment, because the
draft is quoting wording the company no longer stands behind. A human decides
which version governs.

### 4.3 The six states

Every finding carries exactly one label, and the label decides how the UI
presents it and whether it blocks approval.

| State | Meaning | Blocks approval |
|---|---|---|
| `contradicts_fact` | The approved sources say the opposite | yes |
| `unsupported` | No approved source backs the claim | yes |
| `unverifiable` | The cited source could not be checked against its own text | yes |
| `sources_conflict` | Approved sources disagree (e.g. two fact versions) | yes |
| `promotional_puffery` | Superlative language with no factual basis | no (advisory) |
| `compliant` | Checked and supported | no |

Plus one routing outcome that is deliberately not a verdict:
`human_review`, for uncertainty-band claims.

### 4.4 Change safety

- **Facts are versioned, never overwritten.** Editing a fact inserts a new
  version and expires the old one, so historical findings stay explainable.
- **Knowledge changes flag affected content.** When a fact is edited or
  expired, approved drafts that cited it are flagged for re-review
  (database trigger plus a shared, tested predicate).
- **Approvals are revoked, never edited.** Rejection revokes prior
  approvals; revocation is a new state on the record.
- **Rationales have teeth.** Approving with an override rationale requires
  at least 15 characters; "ok" does not count.

### 4.5 The audit chain

Every action (draft created/edited, review run, decision granted or revoked,
fact upserted, guideline edited) appends one row:
`row_hash = SHA-256(prev_hash | actor | action | occurred_at | payload)`.
A BEFORE INSERT trigger computes the hash inside the database; a second
trigger makes UPDATE and DELETE raise. The application can verify the whole
chain end to end (and the workbench shows the result), so anyone with read
access can prove the history is intact, or prove that it is not.

## 5. Architecture

One deployable application. No microservices: in a small-team build, every
service boundary is a place to lose time to integration, so the interface,
the API, the pipeline and the audit logic live in one Next.js codebase with
one Postgres database.

```
imprimatur/
├── PRD.md                        # this document
├── README.md                     # run instructions, verification commands
├── package.json                  # deps: next, react, postgres, zod; dev: tsx, vitest
├── tsconfig.json                 # strict TypeScript, @/ and @seed/ path aliases
├── .env.example                  # DATABASE_URL, model keys, CONFIDENTIAL_MODE
│
├── db/
│   └── schema.sql                # full DDL: auth tables, versioned facts,
│                                 #   guidelines, drafts, review runs, findings,
│                                 #   approvals, audit chain triggers,
│                                 #   RRF hybrid search function,
│                                 #   re-review flag triggers
│
├── seed/
│   └── meridian-flow.ts          # fictional demo brand: 7 approved facts
│                                 #   (one deliberately superseded), terminology
│                                 #   and banned-phrase guidelines, 4 demo drafts
│                                 #   each demonstrating different finding states
│
├── scripts/
│   ├── db-push.ts                # apply schema.sql (multi-statement safe)
│   └── db-seed.ts                # org, persona accounts, knowledge base, drafts
│
├── benchmark/
│   ├── cases.ts                  # 50 golden cases in 4 strata:
│   │                             #   A rules (10), B grounding verdicts (18),
│   │                             #   C conflict/uncertainty (12), D change safety (10)
│   ├── oracle.ts                 # deterministic offline stand-in for the model
│   │                             #   providers, so the benchmark runs with no keys
│   ├── run.ts                    # runner: per-stratum pass/fail, evidence
│   │                             #   recall@5, writes results.json
│   └── results.json              # committed results (offline mode)
│
├── tests/                        # Vitest, 55 tests across 6 files
│   ├── normalizer.test.ts        #   sanitising, span map, hash stability
│   ├── rules.test.ts             #   terminology, puffery, injection, contrast
│   ├── gates.test.ts             #   all three gates, band edges, fallbacks
│   ├── rrf.test.ts               #   fusion order, keyword lane
│   ├── chain.test.ts             #   hash chain, tamper detection, approvals, flags
│   └── passwords.test.ts         #   scrypt round-trip, salting, tokens
│
└── src/
    ├── app/                      # Next.js App Router
    │   ├── layout.tsx            #   root layout
    │   ├── page.tsx              #   renders the workbench
    │   ├── globals.css           #   design tokens, cards, state chips
    │   ├── components/
    │   │   └── workbench.tsx     #   the whole workbench UI (client): editor,
    │   │                         #   persona switcher, presets, finding cards
    │   │                         #   with gate detail, approve/reject, audit view
    │   └── api/                  #   route handlers (all server-side)
    │       ├── auth/login/       #   sign in / sign out (sessions)
    │       ├── me/               #   current user + role
    │       ├── status/           #   provider + confidential-mode disclosure
    │       ├── demo/             #   static demo presets
    │       ├── drafts/           #   list, create, update
    │       ├── drafts/[id]/      #   draft + findings + approvals + flags
    │       ├── drafts/[id]/review/    # run the pipeline, persist findings
    │       ├── drafts/[id]/approve/   # role-gated, hash-bound decisions
    │       ├── facts/            #   list, upsert (embedding computed app-side)
    │       └── audit/            #   entries + chain verification result
    │
    ├── db/
    │   ├── client.ts             #   postgres.js connection (Neon-compatible)
    │   └── repo.ts               #   every query the routes need, typed
    │
    └── lib/                      # the product's brain, dependency-free
        ├── states.ts             #   six-state schema + metadata
        ├── normalizer.ts         #   allowlist sanitiser, markdown-lite,
        │                         #   plain-text span map, SHA-256 content hash
        ├── models.ts             #   ModelGateway: Gemini primary, GLM fallback,
        │                         #   confidential mode, timeouts, zod schemas,
        │                         #   versioned prompts
        ├── passwords.ts          #   scrypt hashing, timing-safe verify, tokens
        ├── session.ts            #   DB-backed sessions, httpOnly cookies
        ├── rules/engine.ts       #   deterministic lane (pure functions)
        ├── retrieval/hybrid.ts   #   RRF merge, keyword/vector scorers,
        │                         #   in-memory twin of the SQL search
        ├── gates/index.ts        #   the three gates, uncertainty band,
        │                         #   lexical entailment with number veto
        ├── pipeline/review.ts    #   dual-lane orchestrator, degradation notes
        ├── audit/chain.ts        #   canonical JSON, row hashing, verification
        └── workflow/
            ├── approval.ts       #   hash binding, role gates, rationale floor
            └── flags.ts          #   re-review flagging on knowledge changes
```

## 6. Technology stack and why

| Layer | Choice | Reasoning |
|---|---|---|
| Application | Next.js 15, App Router, TypeScript | One runtime for UI, API and pipeline; types from database to finding card; one deploy |
| Database | Postgres on Neon, pgvector + tsvector | Facts, drafts, findings and the audit log in one transactional store; both retrieval lanes next to the data they search; no separate vector DB to sync or fail |
| Retrieval | Reciprocal Rank Fusion (k = 50) | Exact codes and clause numbers need the keyword lane; semantics need vectors; RRF merges them without tuning weights per query |
| Models | Gemini Flash (free tier) primary, GLM paid fallback | Schema-constrained structured output on both; a quota failure on an important day is a non-event |
| Entailment | Deterministic lexical check first, model judge only when inconclusive | The trust core runs in testable code, not inside a model; numbers and entities have veto power |
| Auth | First-party scrypt sessions | Small, auditable, fully unit-tested; passwords never leave the verify function; sessions are DB rows so revocation is real |
| Tests | Vitest (55) + 50-case benchmark | Unit tests pin the invariants; the benchmark measures end behaviour, offline (oracle) and live |

## 7. Evaluation

The benchmark (`benchmark/`) is part of the product, not an afterthought:
judges, reviewers or future maintainers can re-run every number.

- **50 golden cases** in four strata: rules (10), grounding verdicts (18),
  conflict and uncertainty (12), change safety (10). Each case is a draft
  fragment plus the expected findings (state and excerpt match).
- **Offline mode** runs with no API keys using a deterministic oracle that
  stands in for the model providers. It measures the gates, retrieval and
  pipeline mechanics: current result **47/50**, with the rules and
  change-safety strata at 100%.
- The three offline misses are by design: a misattributed quote, a vague
  hedged claim and a synonym-attachment case that need live model semantics.
  They are the difference between offline and live numbers, which is why the
  two modes are never mixed in one report.
- **Live mode** (keys required) is the baseline the product reports
  publicly: real extraction, real entailment, same gates.

## 8. Security and privacy model

- **Drafts are attacked, not trusted.** Allowlist sanitisation (scripts,
  event handlers, javascript: URLs and non-allowlisted tags are stripped),
  injection-pattern findings, and no instruction in draft text is ever
  followed by the pipeline.
- **Confidential mode.** With `CONFIDENTIAL_MODE=true` (or no keys), the app
  makes zero external model calls, tells the user so in the UI, and still
  produces deterministic findings.
- **Secrets** live in environment variables only; nothing sensitive is
  committed.
- **Server-side authority.** Roles and session state are read from the
  session on every workflow action; the client is never trusted with them.
- **Auditability over obscurity.** The threat model assumes an insider
  trying to quietly rewrite history; the hash chain is the defense, and it
  is verifiable by anyone with read access.

## 9. Status: what exists and what does not

**Built and verified (tests and build pass):** the entire review engine
(normalizer, deterministic lane, hybrid retrieval, three gates, dual-lane
pipeline), the data model (versioned facts, hash-bound approvals, append-only
audit chain, re-review triggers), the model gateway with fallback and
confidential mode, session auth, all API routes, the workbench UI code, the
demo brand, and the benchmark with its offline oracle. 55 unit tests, strict
TypeScript with zero errors, clean production build.

**Not yet done, in order:**

1. **Live database bring-up.** The schema and queries are written but the
   app has not run against a real Postgres instance yet; first run may
   surface small issues.
2. **Deployment** (Vercel + Neon) and the live-provider benchmark baseline.
3. **Certificate export**: the approved review as a JSON and printable
   artifact.
4. **Deterministic accessibility and visual checks**: axe-core on rendered
   content and sharp-based image/logo inspection (the contrast function
   already exists).
5. **DOCX and PDF ingestion** (mammoth / unpdf), with size caps and
   sanitisers, after the core is proven in use.

## 10. How it was built

Solo-built with AI pair-programming assistance, disclosed openly. The design
decisions, the code review and the responsibility for behaviour sit with the
human owner; the AI accelerated drafting and test-writing. Reused open-source
components are exactly the dependencies in `package.json` (Next.js, React,
postgres.js, zod, TypeScript, Vitest, tsx). Everything else in this
repository was written for this product.
