import { getSessionUser, unauthorized } from '@/lib/session';
import { loadFacts, upsertFact, appendAudit } from '@/db/repo';
import { ModelGateway, modelConfigFromEnv } from '@/lib/models';
import { AUDIT_ACTIONS } from '@/lib/audit/chain';

export async function GET() {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const facts = await loadFacts(user.orgId);
  return Response.json({ facts });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  const body = (await req.json()) as {
    factKey: string; statement: string; sourceTitle?: string; sourceUrl?: string; sourceQuote?: string;
  };
  if (!body.factKey?.trim() || !body.statement?.trim()) {
    return Response.json({ error: 'factKey and statement are required.' }, { status: 400 });
  }
  let embedding: number[] | null = null;
  const gateway = new ModelGateway(modelConfigFromEnv());
  try {
    embedding = (await gateway.embed([body.statement]))?.[0] ?? null;
  } catch { /* keyword lane still covers the fact */ }

  await upsertFact(user.orgId, user.id, { ...body, embedding });
  await appendAudit(user.id, user.orgId, AUDIT_ACTIONS.factUpserted, { factKey: body.factKey });
  // re-review flags for approved drafts citing this key are raised by the
  // fact_change_flags trigger inside the database
  return Response.json({ ok: true, embedded: embedding !== null });
}
