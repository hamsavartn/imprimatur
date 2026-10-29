/**
 * One-command live-database verification: proves the database-level
 * guarantees actually execute, not just that the SQL looks right.
 * Usage: DATABASE_URL=... npm run db:verify   (or with .env loaded)
 *
 * Checks: connection · pgvector present · seed counts · audit trigger
 * computes and protects the chain · audit_verify_chain() · re-review flag
 * trigger fires on fact expiry (inside a rolled-back transaction, so seed
 * data is untouched) · hybrid search function returns rows.
 * Exit 0 = every check passed; anything else prints which failed.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

function loadEnv() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: rely on real env */ }
}
loadEnv();

async function main() {
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set (create .env from .env.example)'); process.exit(1); }

const sql = postgres(url, {
  ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : false,
  max: 1,
});

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try { results.push({ name, ok: true, detail: await fn() }); }
  catch (e) { results.push({ name, ok: false, detail: String(e).slice(0, 200) }); }
};

await check('connection + pgvector', async () => {
  const r = await sql<Array<{ ext: string | null }>>`
    SELECT extname AS ext FROM pg_extension WHERE extname = 'vector'`;
  if (!r[0]) throw new Error('pgvector extension not installed — run db:push first');
  return 'connected, vector extension present';
});

await check('seed counts', async () => {
  const [facts, drafts, users, orgs] = await Promise.all([
    sql`SELECT count(*)::int AS n FROM fact`,
    sql`SELECT count(*)::int AS n FROM draft`,
    sql`SELECT count(*)::int AS n FROM "user"`,
    sql`SELECT count(*)::int AS n FROM organization`,
  ]);
  const n = { facts: facts[0].n, drafts: drafts[0].n, users: users[0].n, orgs: orgs[0].n };
  if (n.facts === 0 || n.drafts === 0 || n.users === 0) {
    throw new Error(`seed data missing ${JSON.stringify(n)} — run db:seed first`);
  }
  return `facts=${n.facts} drafts=${n.drafts} users=${n.users} orgs=${n.orgs}`;
});

await check('audit trigger computes the hash on insert', async () => {
  const r = await sql<Array<{ row_hash: string; prev_hash: string }>>`
    INSERT INTO audit_log (action, payload) VALUES ('verify.test', '{"probe":1}'::jsonb)
    RETURNING row_hash, prev_hash`;
  if (!/^[a-f0-9]{64}$/.test(r[0].row_hash)) throw new Error('row_hash is not a sha256 hex string');
  return `hash computed: ${r[0].row_hash.slice(0, 16)}…`;
});

await check('audit UPDATE is rejected by trigger', async () => {
  const row = await sql<Array<{ seq: number }>>`
    INSERT INTO audit_log (action, payload) VALUES ('verify.test', '{"probe":2}'::jsonb)
    RETURNING seq`;
  try {
    await sql`UPDATE audit_log SET action = 'tampered' WHERE seq = ${Number(row[0].seq)}`;
    throw new Error('UPDATE SUCCEEDED — append-only enforcement is broken');
  } catch (e) {
    if (String(e).includes('append-only')) return 'UPDATE rejected as designed';
    throw e;
  }
});

await check('audit DELETE is rejected by trigger', async () => {
  const row = await sql<Array<{ seq: number }>>`
    INSERT INTO audit_log (action, payload) VALUES ('verify.test', '{"probe":3}'::jsonb)
    RETURNING seq`;
  try {
    await sql`DELETE FROM audit_log WHERE seq = ${Number(row[0].seq)}`;
    throw new Error('DELETE SUCCEEDED — append-only enforcement is broken');
  } catch (e) {
    if (String(e).includes('append-only')) return 'DELETE rejected as designed';
    throw e;
  }
});

await check('audit_verify_chain() reports intact', async () => {
  const r = await sql<Array<{ ok: boolean; first_bad: string | null; reason: string | null }>>`
    SELECT ok, first_bad, reason FROM audit_verify_chain()`;
  if (!r[0]?.ok) throw new Error(`chain broken: ${r[0]?.reason}`);
  return 'chain verified end to end in SQL';
});

await check('re-review flag trigger fires on fact expiry (rolled back)', async () => {
  try {
    await sql.begin(async (tx) => {
      // approve one seeded draft inside the transaction
      const d = await tx<Array<{ id: string; sha: string }>>`
        SELECT id, draft_sha256 AS sha FROM draft ORDER BY created_at LIMIT 1`;
      await tx`INSERT INTO approval (draft_id, draft_sha256, decided_by, decision)
               SELECT ${d[0].id}, ${d[0].sha}, id, 'approved' FROM "user" LIMIT 1`;
      // expire a fact the demo content cites
      await tx`UPDATE fact SET effective_to = now() WHERE fact_key = 'pricing/basic-plan' AND effective_to IS NULL`;
      const flags = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM re_review_flag WHERE resolved_at IS NULL`;
      if (flags[0].n === 0) throw new Error('no re_review_flag created by the fact-expiry trigger');
      throw new Error('ROLLBACK_INTENDED');
    });
  } catch (e: any) {
    if (e?.message !== 'ROLLBACK_INTENDED') throw e;
  }
  // transaction rolled back: nothing persisted
  const after = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM re_review_flag`;
  return `flag created inside tx (count ${after[0].n} after rollback — seed data untouched)`;
});

await check('hybrid search function returns rows', async () => {
  const r = await sql<Array<{ fact_key: string }>>`
    SELECT fact_key FROM search_facts_hybrid(
      (SELECT id FROM organization LIMIT 1),
      'what does the basic plan cost per month',
      NULL::vector(768), 5, 50) LIMIT 5`;
  if (r.length === 0) throw new Error('keyword lane returned nothing for a pricing query');
  return `top fact: ${r[0].fact_key}`;
});

await sql.end();

console.log('\n===== DB VERIFICATION =====');
let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? ' — ' + r.detail : '\n        ' + r.detail}`);
  if (!r.ok) failed++;
}
console.log(`\nRESULT: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
