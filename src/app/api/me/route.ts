import { getSessionUser } from '@/lib/session';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ user: null });
  return Response.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.orgId },
  });
}
