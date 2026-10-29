import { cookies } from 'next/headers';
import { sql } from '@/db/client';
import { dbAvailable } from '@/db/client';
import { getUserById, type OrgUser } from '@/db/repo';
import { SESSION_COOKIE, SESSION_TTL_DAYS, newSessionToken } from '@/lib/passwords';

/**
 * Sessions: a random token in the session table, delivered as an httpOnly
 * cookie. Every workflow action re-reads the session server-side; nothing
 * about the role or identity is trusted from the client.
 */

export async function createSession(userId: string): Promise<string> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
  await sql`
    INSERT INTO "session" (id, token, expires_at, user_id, updated_at)
    VALUES (${crypto.randomUUID()}, ${token}, ${expires}, ${userId}, now())`;
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    expires,
    path: '/',
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await sql`DELETE FROM "session" WHERE token = ${token}`;
  jar.delete(SESSION_COOKIE);
}

export async function signIn(email: string, password: string): Promise<OrgUser | null> {
  const rows = await sql<Array<{ id: string; password: string | null }>>`
    SELECT u.id, a.password
    FROM "user" u JOIN "account" a ON a.user_id = u.id AND a.provider_id = 'credential'
    WHERE lower(u.email) = lower(${email}) LIMIT 1`;
  const row = rows[0];
  if (!row?.password) return null;
  const { verifyPassword } = await import('@/lib/passwords');
  if (!verifyPassword(password, row.password)) return null;
  await createSession(row.id);
  return getUserById(row.id);
}

export async function getSessionUser(): Promise<OrgUser | null> {
  if (!dbAvailable) return null;
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const rows = await sql<Array<{ id: string }>>`
    SELECT s.id FROM "session" s
    WHERE s.token = ${token} AND s.expires_at > now() LIMIT 1`;
  if (!rows[0]) return null;
  const userRows = await sql<Array<{ user_id: string }>>`
    SELECT user_id FROM "session" WHERE id = ${rows[0].id}`;
  return getUserById(userRows[0].user_id);
}

export function unauthorized() {
  return Response.json({ error: 'Sign in required.' }, { status: 401 });
}
