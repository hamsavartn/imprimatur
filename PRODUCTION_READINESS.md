# Production Readiness — Imprimatur

Status: **code-complete and offline-verified; NOT yet deployed; live-database
behavior UNVERIFIED (blocked: no Postgres/Docker on the build machine).**
Every check below states which kind of verification backs it.

## Local verification (DONE, executed on this machine)

- [x] `npm install` — clean
- [x] `npx tsc --noEmit` — strict, 0 errors
- [x] `npm test` — 81/81 (55 original + 26 adversarial)
- [x] `npm run bench` — 47/50 offline (b12/c03/c05 documented live-model cases)
- [x] `npm run build` — production build, 0 errors, all routes compile
- [x] Runtime smoke (dev server): /api/status reports confidential mode honestly;
      /api/demo serves presets; /api/me null without session; /api/drafts 401;
      page renders
- [x] No secrets committed (.env.example only); no dates/times embedded in source

## Database bring-up (PENDING — do at deployment, in this order)

1. Provision Postgres 15+ with pgvector (Neon has it built in; local: `CREATE EXTENSION vector;`).
2. `DATABASE_URL=... npm run db:push` — applies db/schema.sql (idempotent IF NOT EXISTS).
3. `DATABASE_URL=... npm run db:seed` — org, 3 personas, 7 facts, guidelines, 4 drafts.
4. **Verify triggers actually fire** (the audit-critical items never yet executed):
   - `UPDATE audit_log SET action='x' WHERE seq=1;` → must RAISE
   - `SELECT * FROM audit_verify_chain();` after a few app actions → ok=true
   - `UPDATE fact SET effective_to=now() ...` on a cited fact → re_review_flag rows appear
5. Run one full workflow through the UI: sign in → preset → save → review → findings → approve (as reviewer) → audit view green.
6. Confirm the approve route's hash binding: edit the draft, then re-approve attempt on the old approval → blocked.

## Deployment checklist

- [ ] Push repo (owner does this — git intentionally untouched by the agent)
- [ ] Vercel project + env vars: DATABASE_URL, BETTER_AUTH-free (first-party sessions need none), GEMINI_API_KEY (optional), ZAI_API_KEY (optional), CONFIDENTIAL_MODE
- [ ] `BETTER_AUTH_*` vars in .env.example are vestigial from the removed dependency — delete on next touch (cosmetic)
- [ ] First deploy: expect cold-start route compile; /api/status should show the provider label
- [ ] Live benchmark baseline: `npm run bench -- --live` with keys set; commit results separately from offline results
- [ ] Set a session TimeZone expectation (e.g. UTC) so audit verification sessions match the trigger's

## Known operational limitations (disclosed, not hidden)

1. **Live DB paths are unverified** — triggers, multi-org isolation, cookies, concurrency. The SQL is written, reviewed by two passes, but never executed. Highest-risk open item.
2. **Audit log is tamper-EVIDENT, not tamper-PROOF**: a DB superuser can truncate and forge a valid-looking chain (no external head anchor). Documented; external checkpoint proposed as future hardening.
3. **Approval on degraded reviews is disclosed, not blocked** — confidential mode is a legitimate operating mode; the approval record names the review lane.
4. **Lexical entailment caps are heuristics**, not calibrated probabilities; the uncertainty band exists precisely because of this.
5. **Benchmark offline mode** measures gates/retrieval/pipeline with a deterministic oracle; it says nothing about live model accuracy — never mix modes in one report.
6. `.env.example` still lists BETTER_AUTH_* vars from the removed dependency.
7. The demo personas self-provision on first login (documented in the route); fine for a hackathon demo, not for real multi-tenancy.

## Recovery

- Database: re-run `db:push` (idempotent schema) + `db:seed` (refreshes demo content; wipes org-scoped demo rows). Audit log survives seeding (not org-scoped deletes).
- App: `npm run build && npm start`; health signal = `/api/status`.

---

# Second mission addendum

- **Single verification pipeline:** `npm run verify` — executable stages PASS
  (env, typecheck, 90 tests, benchmark, build, secret scan); npm audit runs
  report-only; DB/concurrency/runtime-smoke stages print BLOCKED with the
  exact prerequisite; lint NOT RUN (no linter configured — documented decision).
- **Dependency vulnerabilities dispositioned:** postcss-via-next (high):
  build-time only, no runtime user-CSS path; fix = breaking next@16 major —
  rejected pre-demo, revisit post-event. zod (high): mitigated in code
  (parseBounded size gate + claims cap) without the breaking 4.x upgrade.
- **E2E smoke exists and passes:** e2e/e2e-smoke.mjs (7/7) covers the
  no-DB/no-key surface in a real browser; DB-backed journey remains on the
  deployment checklist below.
- **Claim-coverage disclosure shipped:** reviews now report claimsExtracted
  and never claim full verification of a document.
- Remaining blockers unchanged: live PostgreSQL bring-up (triggers, sessions,
  multi-org, concurrency), deployment, live-provider benchmark baseline.
