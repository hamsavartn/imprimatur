/**
 * Apply db/schema.sql to DATABASE_URL. Multi-statement safe: the file is
 * sent as one simple query, so trigger bodies ($$…$$) survive intact.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

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
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(1);
  }
  const sql = postgres(url, { ssl: url.includes('neon.tech') ? { rejectUnauthorized: false } : false, max: 1 });
  const schemaPath = new URL('../db/schema.sql', import.meta.url);
  const schema = readFileSync(schemaPath, 'utf8');
  await sql.unsafe(schema);
  console.log('schema applied');
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
