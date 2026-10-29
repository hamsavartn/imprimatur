# Product Roadmap — Imprimatur

Where the product goes after the event. Sequenced by dependency, not by wish:
each phase unlocks the next. Honest markers: ✅ shipped and tested in this
repository; 🔜 next; 🧭 later, credible but unstarted.

## Now (shipped in this repo)

- ✅ Dual-lane review engine: deterministic rules + grounded claim verification
  through three gates, six-state epistemics, human-review uncertainty band
- ✅ Hash-bound approvals, role-gated workflow, re-review flags on knowledge change
- ✅ Append-only hash-chained audit log, verified in SQL (`audit_verify_chain()`)
- ✅ Compliance certificate: machine-checkable JSON artifact + printable page
- ✅ Deterministic accessibility lane: contrast (WCAG AA incl. large-text rule),
  alt text, heading order, link text — measured 100% recall / 100% precision on
  the 17-violation planted fixture (deterministic checks only; browser-level
  audits remain out of scope, stated everywhere results appear)
- ✅ 50-case golden benchmark + adversarial + hardening suites (102 tests),
  one-command verification (`npm run verify`), E2E smoke of the confidential surface

## 🔜 Next (deployment-adjacent, ordered)

1. **Live bring-up**: Postgres/pgvector instance, schema push, seed, trigger
   verification (the audit-critical items in PRODUCTION_READINESS.md), Vercel
   deploy, live-provider benchmark baseline. Everything downstream assumes this.
2. **Approval workspace depth**: finding resolution flow (mark resolved →
   instant re-review of the edited block only), comment threads on findings,
   reviewer queues.
3. **Certificate hardening**: detached signature with a managed key so the
   certificate establishes issuer identity, plus a public verification endpoint
   (`/verify/<hash>`) judges or CMS pipelines can call without an account.

## 🧭 Then (the real product)

4. **Ingestion**: DOCX (mammoth) and PDF (unpdf) with size caps, sanitisers and
   their own fixtures; channel profiles (social / product page / regulated doc)
   changing which deterministic rules apply.
5. **Knowledge-base experience**: fact editor with effective/expiry dates,
   import from existing guideline documents, guideline-usage analytics (which
   rules get overridden every week — the "rule needs rewriting" signal).
6. **Editor plug-ins**: findings surfaced while writing (browser extension,
   Google Docs add-on), with the publication gate unchanged — checking moves
   earlier, the gate stays.
7. **Accessibility depth**: real-browser audits (axe-core in CI) layered on the
   deterministic lane; brand-asset checks (logo palette distance, minimum
   dimensions) on the same deterministic philosophy — never a vision model
   guessing hex values.
8. **Multi-team tenancy**: real org isolation hardening, invites, SSO for the
   self-hosted confidential mode.

## Non-goals (deliberate)

- No generative writing assistance: the product judges content, it does not
  write it.
- No vision-model brand checks: colour and layout arithmetic stays deterministic.
- No blockchain/external trust infrastructure: the audit chain is tamper-evident
  with external hash checkpoints if a customer needs stronger anchoring.
