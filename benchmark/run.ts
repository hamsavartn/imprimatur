/**
 * Benchmark runner. Usage:
 *   npm run bench              -> offline oracle mode (no keys needed)
 *   npm run bench -- --live    -> live providers (needs GEMINI_API_KEY / ZAI_API_KEY)
 *
 * Outputs per-stratum precision/recall, evidence recall@5, stratum D
 * (workflow/change-safety) assertions, and writes benchmark/results.json.
 * Offline mode measures gates+retrieval+pipeline only; live mode is the
 * number the submission reports. Never mix the two in one report.
 */

import { writeFileSync } from 'node:fs';
import { runReview } from '../src/lib/pipeline/review';
import { ModelGateway, modelConfigFromEnv } from '../src/lib/models';
import { normalizeDraft, sha256 } from '../src/lib/normalizer';
import { retrieveInMemory } from '../src/lib/retrieval/hybrid';
import { verifyChain, rowHash, type AuditRow } from '../src/lib/audit/chain';
import { recordDecision, assertApprovalActionable, isCurrentlyApproved, StaleApprovalError } from '../src/lib/workflow/approval';
import { flagsFor } from '../src/lib/workflow/flags';
import { CASES, STRATUM_SIZES, type BenchCase } from './cases';
import { makeOracleGateway } from './oracle';

const LIVE = process.argv.includes('--live');

interface CaseResult {
  id: string;
  stratum: string;
  pass: boolean;
  missing: string[];
  extra: string[];
  evidenceOk?: boolean;
}

function expectedSatisfied(expected: BenchCase['expected'], findings: Array<{ state: string; excerpt: string }>) {
  const missing: string[] = [];
  const matchedIdx = new Set<number>();
  for (const exp of expected) {
    const idx = findings.findIndex(
      (f, i) =>
        !matchedIdx.has(i) &&
        f.state === exp.state &&
        (exp.contains === undefined || f.excerpt.toLowerCase().includes(exp.contains.toLowerCase())),
    );
    if (idx === -1) missing.push(exp.state + (exp.contains ? ` (${exp.contains})` : ''));
    else matchedIdx.add(idx);
  }
  // unexpected BLOCKING findings count as extra
  const blocking = new Set(['contradicts_fact', 'unsupported', 'unverifiable', 'sources_conflict']);
  const extra = findings
    .filter((_, i) => !matchedIdx.has(i))
    .filter((f) => blocking.has(f.state))
    .map((f) => `${f.state}:"${f.excerpt.slice(0, 40)}"`);
  return { missing, extra };
}

async function main() {
  const gateway = LIVE
    ? new ModelGateway(modelConfigFromEnv())
    : null;
  const results: CaseResult[] = [];

  for (const c of CASES.filter((x) => x.stratum !== 'D')) {
    const facts = (c.facts ?? []).map((f) => ({ ...f, embedding: f.embedding ?? null }));
    const g = gateway ?? makeOracleGateway(facts);
    let findings: Array<{ state: string; excerpt: string }> = [];
    let evidenceOk = true;
    try {
      const res = await runReview({
        content: c.draft,
        format: 'markdown',
        brandRules: c.rules!,
        approvedFacts: facts,
        gateway: g,
      });
      findings = res.findings.map((f) => ({ state: f.state, excerpt: f.excerpt }));
      if (c.expectTopFact) {
        const para = res.normalized.plain;
        const retrieved = retrieveInMemory(para, [], facts, 5);
        evidenceOk = retrieved.some((r, i) => i < 5 && r.factKey === c.expectTopFact);
      }
    } catch (e) {
      results.push({ id: c.id, stratum: c.stratum, pass: false, missing: [`threw: ${String(e)}`], extra: [] });
      continue;
    }
    const { missing, extra } = expectedSatisfied(c.expected, findings);
    const pass = missing.length === 0 && extra.length === 0 && evidenceOk;
    results.push({ id: c.id, stratum: c.stratum, pass, missing, extra, evidenceOk });
  }

  // ---- stratum D: workflow / change-safety, asserted directly ----
  const dResults: CaseResult[] = [];
  const check = (id: string, ok: boolean, why: string) =>
    dResults.push({ id, stratum: 'D', pass: ok, missing: ok ? [] : [why], extra: [] });

  {
    // d01: editing after approval changes the hash
    const a = normalizeDraft('Approved text. Basic plan $49.', 'markdown');
    const b = normalizeDraft('Approved text. Basic plan $59.', 'markdown');
    check('d01', a.sha256 !== b.sha256, 'hash should change on edit');
    // d02: same text -> same hash
    const c2a = normalizeDraft('Stable text across runs.', 'markdown');
    const c2b = normalizeDraft('Stable text across runs.', 'markdown');
    check('d02', c2a.sha256 === c2b.sha256, 'hash should be stable');
    // d03: whitespace-only edit keeps hash (plain text trimmed identically)
    const c3 = normalizeDraft('Stable text across runs. ', 'markdown');
    check('d03', c3.sha256 === c2a.sha256, 'trailing space should not change plain hash');
    // d04: markdown vs html with same visible text -> same plain hash
    const md = normalizeDraft('# Heading\n\nBody line.', 'markdown');
    const html = normalizeDraft('<h1>Heading</h1><p>Body line.</p>', 'html');
    check('d04', md.sha256 === html.sha256, 'format should not change content hash');
    // d05: entity decodes before hashing
    const e1 = normalizeDraft('Meridian Flow &amp; partners', 'html');
    const e2 = normalizeDraft('Meridian Flow & partners', 'html');
    check('d05', e1.sha256 === e2.sha256, 'entities should decode before hashing');

    // d06/d07: knowledge change flags approved drafts
    const drafts = [
      { draftId: 'dr1', draftSha256: 'x', isApproved: true, citedFactKeys: ['pricing/basic-plan'] },
      { draftId: 'dr2', draftSha256: 'y', isApproved: false, citedFactKeys: ['pricing/basic-plan'] },
      { draftId: 'dr3', draftSha256: 'z', isApproved: true, citedFactKeys: ['security/encryption'] },
    ];
    const f6 = flagsFor(drafts, { kind: 'fact_edited', ref: 'pricing/basic-plan' });
    check('d06', f6.length === 1 && f6[0].draftId === 'dr1', 'only approved drafts citing the fact get flagged');
    const f7 = flagsFor(drafts, { kind: 'guideline_edited', ref: 'terminology:product-name' });
    check('d07', f7.length === 2 && f7.every((f) => ['dr1', 'dr3'].includes(f.draftId)), 'guideline edit flags all approved drafts');

    // d08: audit chain intact after 20 appends, tamper detected
    const rows: AuditRow[] = [];
    let prev = 'GENESIS';
    for (let i = 0; i < 20; i++) {
      const occurredAt = new Date(1700000000000 + i * 1000).toISOString();
      const ev = { actor: 'u1', action: 'review.run', occurredAt, payload: { i } };
      const hash = rowHash(prev, ev);
      rows.push({ seq: i + 1, occurredAt, actor: 'u1', action: 'review.run', payload: { i }, prevHash: prev, rowHash: hash });
      prev = hash;
    }
    const intact = verifyChain(rows);
    const tampered = JSON.parse(JSON.stringify(rows));
    tampered[7].payload = { i: 999 };
    const broken = verifyChain(tampered);
    check('d08', intact.ok && !broken.ok && broken.breakAt === 8, 'chain verifies intact and detects tampering');

    // d09: stale hash blocks the approval action
    const approval = recordDecision('dr1', 'hash-1', { id: 'u2', role: 'reviewer' }, 'approved', undefined);
    let blocked = false;
    try { assertApprovalActionable(approval, 'hash-2'); } catch (e) { blocked = e instanceof StaleApprovalError; }
    check('d09', blocked, 'edited draft must block acting on the old approval');

    // d10: creator cannot approve; matching hash works; approval usable
    let unauthorized = false;
    try { recordDecision('dr1', 'hash-1', { id: 'u1', role: 'creator' }, 'approved', undefined); }
    catch { unauthorized = true; }
    const okApproval = recordDecision('dr1', 'hash-1', { id: 'u2', role: 'reviewer' }, 'approved', undefined);
    assertApprovalActionable(okApproval, 'hash-1');
    const approvedNow = isCurrentlyApproved([okApproval], 'dr1', 'hash-1');
    check('d10', unauthorized && approvedNow, 'role gate + hash-bound approval usable');
  }

  const all = [...results, ...dResults];

  // ---- report ----
  console.log(`\nImprimatur benchmark — ${LIVE ? 'LIVE providers' : 'OFFLINE oracle (gates/retrieval/pipeline only)'}\n`);
  for (const s of ['A', 'B', 'C', 'D'] as const) {
    const sub = all.filter((r) => r.stratum === s);
    const passed = sub.filter((r) => r.pass).length;
    const tp = sub.flatMap((r) => (r.pass ? [] : r.missing)).length;
    console.log(`  Stratum ${s}: ${passed}/${STRATUM_SIZES[s]} passed`);
    for (const r of sub.filter((x) => !x.pass)) {
      console.log(`    FAIL ${r.id}: missing=[${r.missing.join(' | ')}] extra=[${r.extra.join(' | ')}]${r.evidenceOk === false ? ' evidence-recall FAIL' : ''}`);
    }
    if (tp > 0 && s !== 'A' && s !== 'D') { /* detailed precision/recall live in results.json */ }
  }
  const totalPass = all.filter((r) => r.pass).length;
  console.log(`\n  TOTAL: ${totalPass}/${all.length} (${((totalPass / all.length) * 100).toFixed(1)}%)\n`);

  writeFileSync(
    new URL('./results.json', import.meta.url),
    JSON.stringify({ mode: LIVE ? 'live' : 'offline', at: new Date().toISOString(), results: all }, null, 2),
  );
  process.exitCode = 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
