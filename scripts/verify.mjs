#!/usr/bin/env node
/**
 * The one-command verification pipeline. Stages run sequentially; a failing
 * required stage aborts with a nonzero exit. Blocked stages print why and
 * never convert into passes.
 *
 *   npm run verify
 *
 * Stages:
 *   A  dependencies + environment        (required)
 *   C  strict TypeScript                 (required)
 *   D  unit + adversarial tests          (required)
 *   E  security regression tests         (required; part of D via vitest)
 *   G  retrieval/evidence verification   (required; covered by D + K)
 *   K  offline benchmark                 (required; 47/50 with 3 documented live-model cases)
 *   L  production build                  (required)
 *   N  dependency vulnerability scan     (report-only; findings recorded, not blocking —
 *                                         see PRODUCTION_READINESS.md for dispositions)
 *   O  secret-exposure scan              (required)
 *   F  database integration              (BLOCKED without DATABASE_URL + Postgres/pgvector)
 *   I  concurrency (DB)                  (BLOCKED, same)
 *   J  end-to-end browser smoke          (BLOCKED unless a dev server is running)
 *   M  production runtime smoke          (BLOCKED without a built+started server)
 *   B  lint/format                       (NOT RUN: no linter configured; adding one
 *                                         pre-demo is unjustified churn)
 */

import { spawnSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const results = [];
const npx = (args, opts = {}) =>
  spawnSync('npx', args, { shell: process.platform === 'win32', encoding: 'utf8', ...opts });

function stage(id, name, fn) {
  process.stdout.write(`\n[${id}] ${name}\n`);
  try {
    const r = fn();
    results.push({ id, name, status: r });
  } catch (e) {
    results.push({ id, name, status: 'FAIL', detail: String(e.message ?? e) });
  }
}

const npmArgs = process.platform === 'win32' ? { shell: true } : {};

stage('A', 'dependencies + environment', () => {
  if (!existsSync('node_modules')) throw new Error('node_modules missing: run npm install');
  const v = spawnSync('node', ['-v'], { encoding: 'utf8', ...npmArgs });
  process.stdout.write(`  node ${v.stdout.trim()}, deps installed\n`);
  return 'PASS';
});

stage('C', 'strict TypeScript', () => {
  // --incremental false: a committed tsbuildinfo must not serve a cached result
  const r = npx(['tsc', '--noEmit', '--incremental', 'false']);
  if (r.status !== 0) throw new Error(r.stdout || 'typecheck failed');
  process.stdout.write('  0 errors\n');
  return 'PASS';
});

stage('D+E+G', 'unit, security-regression, retrieval tests (vitest)', () => {
  const r = npx(['vitest', 'run']);
  const out = `${r.stdout}\n${r.stderr}`;
  const m = out.match(/Tests\s+(\d+) passed/);
  process.stdout.write(`  ${m ? m[1] + ' passed' : '(see output)'}\n`);
  if (r.status !== 0) throw new Error(out.slice(-2000));
  return 'PASS';
});

stage('K', 'offline benchmark (score enforced)', () => {
  const r = npx(['tsx', 'benchmark/run.ts']);
  const total = (r.stdout.match(/TOTAL: (\d+)\/(\d+)/) ?? []);
  if (r.status !== 0) throw new Error('benchmark crashed');
  if (!total[1]) throw new Error('no TOTAL line found in benchmark output');
  const passed = +total[1], all = +total[2];
  // ENFORCED: the golden score must match the committed baseline exactly.
  // If golden cases are deliberately changed, update this line in the same
  // commit — a silent regression fails the pipeline here.
  if (!(passed === 47 && all === 50)) {
    throw new Error(`benchmark score ${passed}/${all} != committed baseline 47/50 (see BENCHMARK_REPORT.md)`);
  }
  process.stdout.write(`  ${passed}/${all} (offline oracle; 3 documented live-model cases)\n`);
  return 'PASS';
});

stage('L', 'production build', () => {
  const r = npx(['next', 'build']);
  if (r.status !== 0) throw new Error(`${r.stdout}\n${r.stderr}`.slice(-2000));
  process.stdout.write('  compiled\n');
  return 'PASS';
});

stage('N', 'dependency vulnerability scan (report-only)', () => {
  const r = npx(['npm', 'audit', '--omit=dev']);
  const tail = r.stdout.trim().split('\n').slice(-2).join(' ');
  process.stdout.write(`  ${tail}\n  disposition: see PRODUCTION_READINESS.md (postcss-via-next build-time only;\n  zod exhaustion mitigated in code via bounded validation)\n`);
  return 'REPORTED';
});

stage('O', 'secret-exposure scan', () => {
  const patterns = [/sk-[A-Za-z0-9-]{20,}/, /AIza[A-Za-z0-9_-]{30,}/];
  const dirs = ['src', 'tests', 'benchmark', 'scripts', 'seed', 'db', 'e2e'];
  const sentinel = 'GREP_RAN_NO_MATCH';
  let hits = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let out = '';
    try {
      out = execSync(
        `grep -rnE "sk-|AIza" ${dir} --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.mjs' || echo ${sentinel}`,
        { encoding: 'utf8', shell: process.platform === 'win32' },
      );
    } catch (e) {
      throw new Error(`grep failed for ${dir} — cannot verify secrets (${String(e).slice(0, 80)})`);
    }
    if (out.includes(sentinel)) continue;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      if (patterns.some((p) => p.test(line))) {
        process.stdout.write(`  SUSPECT: ${line.slice(0, 120)}\n`);
        hits++;
      }
    }
  }
  if (hits > 0) throw new Error(`${hits} potential secrets found`);
  process.stdout.write('  no secrets in tracked sources (grep verified running)\n');
  return 'PASS';
});

stage('F', 'database integration (real PostgreSQL + pgvector)', () => {
  if (!process.env.DATABASE_URL) {
    process.stdout.write('  BLOCKED: DATABASE_URL not set. Bring-up checklist: PRODUCTION_READINESS.md\n');
    return 'BLOCKED';
  }
  process.stdout.write('  DATABASE_URL present — run scripts/db-push.ts + db-seed.ts and the trigger checks\n');
  return 'BLOCKED';
});

stage('I', 'concurrency tests (DB-backed)', () => {
  process.stdout.write('  BLOCKED: requires live PostgreSQL (advisory lock, approval races)\n');
  return 'BLOCKED';
});

stage('J', 'end-to-end browser smoke', () => {
  process.stdout.write('  BLOCKED in pipeline: start the app (npm run dev) and run e2e/e2e-smoke.mjs separately\n');
  return 'BLOCKED';
});

stage('M', 'production runtime smoke', () => {
  process.stdout.write('  BLOCKED: requires a started production server (npm start)\n');
  return 'BLOCKED';
});

stage('B', 'lint/format', () => {
  process.stdout.write('  NOT RUN: no linter configured (documented decision)\n');
  return 'NOT RUN';
});

const fail = results.filter((r) => r.status === 'FAIL');
console.log('\n===== VERIFICATION SUMMARY =====');
for (const r of results) console.log(`  ${r.status.padEnd(9)} [${r.id}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
if (fail.length > 0) {
  console.log(`\nRESULT: FAIL (${fail.length} stage(s))`);
  process.exit(1);
}
console.log('\nRESULT: all executable stages passed; blocked stages require external prerequisites (DB, server, keys).');
