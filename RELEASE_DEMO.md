# Release Demo — Imprimatur (judge-facing, reproducible)

Every step uses the real application. Nothing here is hardcoded or simulated.
Setup: `npm install && npm run db:push && npm run db:seed && npm run dev`
(needs DATABASE_URL). Without a database or keys the confidential-mode fallback
(section 8) runs instead and is itself part of the demo.

## 1. The claim that legitimately passes (evidence shown)

Preset "Quarterly reliability post" → Save → Run review.
Findings show `compliant` cards with the verbatim approved quote, the fact key
and the per-gate detail (G1 closed set, G2 verbatim, G3 entailment with
confidence). The uptime, SLA and encryption sentences are backed by the seeded
approved facts — a judge can open any card and see the source.

## 2. The unsupported claim (refused, not guessed)

Preset "Pricing page launch email" contains "auto-negotiates customs duties in
30 countries"-class claims and a wrong price. Review shows `unsupported`
(no approved source) and `contradicts_fact` (wrong number against the pricing
fact) — the card states exactly which gate failed and why.

## 3. The quotation-manipulation attempt (attacker view)

The launch email also says "$39 per workspace per month" while citing the
pricing fact whose quote says $49. Gate 2 rejects the quote-extraction path:
the card shows G2 fail ("Quote does not appear in the approved source text")
and the finding lands as `unverifiable`/`contradicts_fact`, never compliant.
In the offline harness the same attack is pinned: a stitched quote, a
one-word-skipped quote and a negation-removed quote all fail Gate 2
(tests/adversarial.test.ts).

## 4. Approval invalidation (exact-text binding)

As Rahul (reviewer): approve the clean reliability post → success message
shows the content hash it is bound to. Edit one character of the draft → Save.
The old approval no longer matches: any action against it is refused with
"the draft changed after this decision" — enforced server-side by hash
comparison, not by the UI.

## 5. Fact-version change and re-review

As admin: update a fact the approved draft cited (e.g. the SLA). The draft
gains a re-review flag (database trigger + tested predicate), demonstrating
that approvals do not outlive the knowledge they were checked against.

## 6. Audit-chain verification

Open the audit trail: every step from this demo is a row with its hash, and
the chain verification result is displayed. Say precisely what is true: rows
are appended and UPDATE/DELETE are rejected by database triggers; the chain is
tamper-EVIDENT and independently verifiable — not "immutable" against a
database superuser, and the docs say so.

## 7. Mode disclosure (honesty is part of the product)

The banner names the current provider state at all times. With keys: which
provider is in use, per review. Without: "confidential mode — deterministic
lane only". Reviews report their claim-coverage note ("N claims extracted and
checked; extraction completeness is not guaranteed") — the system never
claims to have fully verified a document.

## 8. Fallback: provider unavailable (rehearsed, not hypothetical)

With no keys: the same journey runs on the deterministic lane. Brand
violations, banned phrases, puffery and prompt-injection findings still
appear; approvals still bind to hashes; the audit chain still verifies. The
banner and the approval record disclose the degraded lane — disclosure is the
feature, not a defect to hide. This exact surface is verified by the E2E
smoke (e2e/e2e-smoke.mjs, 7/7) including the honest "Sign in required."
behavior without a session.

## What this demo does NOT show (say it if asked)

Live-model extraction/entailment quality (needs API keys; offline oracle
benchmark 47/50 measures the gates, not the model), database trigger behavior
(needs the live DB; schema is reviewed but trigger execution is on the
deployment checklist), DOCX/PDF ingestion and the certificate export
(planned scope).
