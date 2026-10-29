import { sql } from '@/db/client';
import { getSessionUser, unauthorized } from '@/lib/session';
import { listAudit } from '@/db/repo';

export async function GET() {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const rows = await listAudit(user.orgId);
  // verification runs inside the database, recomputing each hash with the
  // same expressions the insert trigger used, so it can never disagree with
  // how the hashes were produced
  const verify = await sql<Array<{ ok: boolean; first_bad: string | null; reason: string | null }>>`
    SELECT ok, first_bad, reason FROM audit_verify_chain()`;
  const v = verify[0] ?? { ok: true, first_bad: null, reason: null };
  return Response.json({
    entries: rows.map((r) => ({
      seq: r.seq, at: r.occurred_at, actor: r.actor, action: r.action, payload: r.payload, rowHash: r.row_hash,
    })),
    chain: { ok: v.ok, breakAt: v.first_bad, reason: v.reason },
  });
}
