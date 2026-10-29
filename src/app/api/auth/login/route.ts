import { sql } from '@/db/client';
import { dbAvailable } from '@/db/client';
import { signIn, destroySession } from '@/lib/session';
import { hashPassword } from '@/lib/passwords';

export const dynamic = 'force-dynamic';

/**
 * Sign in. The demo personas (@meridianflow.dev) self-provision on first
 * login with their role so the judge journey is one click; every other
 * account must already exist.
 */
export async function POST(req: Request) {
  if (!dbAvailable) return Response.json({ error: 'Database not configured.' }, { status: 503 });
  const body = (await req.json()) as { email: string; password: string };
  const email = body.email?.trim().toLowerCase();
  if (!email || !body.password) return Response.json({ error: 'Email and password required.' }, { status: 400 });

  const existing = await sql<Array<{ id: string }>>`SELECT id FROM "user" WHERE lower(email) = ${email} LIMIT 1`;
  if (!existing[0] && email.endsWith('@meridianflow.dev')) {
    const role = email.startsWith('rahul') ? 'reviewer' : email.startsWith('admin') ? 'admin' : 'creator';
    const org = await sql<Array<{ id: string }>>`SELECT id FROM organization WHERE slug = 'meridian-flow' LIMIT 1`;
    if (org[0]) {
      await sql`
        INSERT INTO "user" (id, name, email, email_verified, org_id, role)
        VALUES (${crypto.randomUUID()}, ${email.split('@')[0]}, ${email}, true, ${org[0].id}, ${role})`;
      const created = await sql<Array<{ id: string }>>`SELECT id FROM "user" WHERE lower(email) = ${email} LIMIT 1`;
      await sql`
        INSERT INTO "account" (id, account_id, provider_id, user_id, password)
        VALUES (${crypto.randomUUID()}, ${email}, 'credential', ${created[0].id}, ${hashPassword(body.password)})`;
    }
  }

  const user = await signIn(email, body.password);
  if (!user) return Response.json({ error: 'Invalid email or password.' }, { status: 401 });
  return Response.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

/** Sign out. */
export async function DELETE() {
  await destroySession();
  return Response.json({ ok: true });
}
