/**
 * Seed the demo workspace: organisation, three role accounts, the Meridian
 * Flow knowledge base (facts incl. one superseded version, guidelines) and
 * the demo drafts. Idempotent: re-running refreshes content rows.
 *
 * Personas: priya@meridianflow.dev (creator), rahul@meridianflow.dev
 * (reviewer), admin@meridianflow.dev (admin). Password for all:
 * demo-password-1
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { FACTS, RULES, DRAFTS, ORG } from '../seed/meridian-flow';
import { normalizeDraft } from '../src/lib/normalizer';
import { hashPassword } from '../src/lib/passwords';

function loadEnv() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: rely on real env */ }
}

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const sql = postgres(url, { ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : false, max: 1 });

  // organisation
  const org = await sql<Array<{ id: string }>>`
    INSERT INTO organization (name, slug) VALUES (${ORG.name}, ${ORG.slug})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;
  const orgId = org[0].id;

  // role accounts (user row directly; demo passwords are public knowledge)
  const personas = [
    { email: 'priya@meridianflow.dev', name: 'Priya (creator)', role: 'creator' },
    { email: 'rahul@meridianflow.dev', name: 'Rahul (reviewer)', role: 'reviewer' },
    { email: 'admin@meridianflow.dev', name: 'Org admin', role: 'admin' },
  ];
  const ids: Record<string, string> = {};
  for (const p of personas) {
    const row = await sql<Array<{ id: string }>>`
      INSERT INTO "user" (id, name, email, email_verified, org_id, role)
      VALUES (${crypto.randomUUID()}, ${p.name}, ${p.email}, true, ${orgId}, ${p.role})
      ON CONFLICT (email) DO UPDATE SET org_id = ${orgId}, role = ${p.role}, name = ${p.name}
      RETURNING id`;
    ids[p.email] = row[0].id;
    await sql`
      INSERT INTO "account" (id, account_id, provider_id, user_id, password)
      VALUES (${crypto.randomUUID()}, ${p.email}, 'credential', ${row[0].id}, ${hashPassword('demo-password-1')})
      ON CONFLICT DO NOTHING`;
  }
  const admin = ids['admin@meridianflow.dev'];

  // facts: insert fresh with valid uuids per factId
  const factUuids: Record<string, string> = {};
  for (const f of FACTS) factUuids[f.factId] = crypto.randomUUID();

  const factVersions: Record<string, number> = {
    'f-sla-old': 1,
    'f-sla': 2,
  };

  await sql`UPDATE fact SET superseded_by = NULL WHERE org_id = ${orgId}`;
  await sql`DELETE FROM fact WHERE org_id = ${orgId}`;
  for (const f of FACTS) {
    const version = factVersions[f.factId] ?? 1;
    const supersededId = f.superseded ? (factUuids['f-sla'] ?? null) : null;
    await sql`
      INSERT INTO fact (id, org_id, fact_key, version, statement, source_title, source_url, source_quote, created_by, superseded_by)
      VALUES (${factUuids[f.factId]}, ${orgId}, ${f.factKey}, ${version}, ${f.statement}, ${f.sourceTitle}, ${f.sourceUrl},
              ${f.sourceQuote}, ${admin}, ${supersededId})`;
  }

  // guidelines
  await sql`DELETE FROM guideline WHERE org_id = ${orgId}`;
  for (const t of RULES.terminology) {
    await sql`
      INSERT INTO guideline (org_id, kind, must_use, must_avoid, note, severity)
      VALUES (${orgId}, 'terminology', ${t.mustUse}, ${t.mustAvoid.join('|')}, ${t.note ?? null}, ${t.severity})`;
  }
  for (const b of RULES.bannedPhrases) {
    await sql`
      INSERT INTO guideline (org_id, kind, must_avoid, note, severity)
      VALUES (${orgId}, 'banned_phrase', ${b.phrase}, ${b.note ?? null}, ${b.severity})`;
  }

  // demo drafts (as the creator)
  const creator = ids['priya@meridianflow.dev'];
  await sql`DELETE FROM draft WHERE org_id = ${orgId}`;
  for (const d of DRAFTS) {
    const n = normalizeDraft(d.content, 'markdown');
    await sql`
      INSERT INTO draft (id, org_id, title, content, content_plain, draft_sha256, created_by)
      VALUES (${crypto.randomUUID()}, ${orgId}, ${d.title}, ${n.html}, ${n.plain}, ${n.sha256}, ${creator})`;
  }

  console.log('seeded:', ORG.name, '| facts:', FACTS.length, '| guidelines:', RULES.terminology.length + RULES.bannedPhrases.length, '| drafts:', DRAFTS.length);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
