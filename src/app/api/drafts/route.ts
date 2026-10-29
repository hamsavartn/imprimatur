import { getSessionUser, unauthorized } from '@/lib/session';
import { listDrafts, upsertDraft, appendAudit, getDraft } from '@/db/repo';
import { normalizeDraft } from '@/lib/normalizer';
import { AUDIT_ACTIONS } from '@/lib/audit/chain';
import { draftTooLarge, titleTooLong } from '@/lib/validate';

export async function GET() {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  return Response.json({ drafts: await listDrafts(user.orgId) });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user?.orgId) return unauthorized();
  // reject oversized bodies BEFORE materializing them (content-length is
  // enforced again after parse — defense in depth, not the only gate)
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > 1_000_000) return Response.json({ error: 'Request body too large.' }, { status: 413 });
  const body = (await req.json()) as { id?: string; title?: string; content: string; format?: 'markdown' | 'html' };
  if (typeof body.content !== 'string' || !body.content.trim()) {
    return Response.json({ error: 'Content required.' }, { status: 400 });
  }
  if (typeof body.title !== 'undefined' && typeof body.title !== 'string') {
    return Response.json({ error: 'Title must be a string.' }, { status: 400 });
  }
  if (draftTooLarge(body.content)) return Response.json({ error: 'Draft exceeds the size limit.' }, { status: 413 });
  if (titleTooLong(body.title ?? '')) return Response.json({ error: 'Title exceeds the length limit.' }, { status: 413 });

  // ownership check before any update: a forged id from another organisation
  // must get a 404, not an overwrite (upsertDraft enforces this too)
  if (body.id) {
    const existing = await getDraft(body.id);
    if (!existing || existing.org_id !== user.orgId) {
      return Response.json({ error: 'Not found.' }, { status: 404 });
    }
  }

  const normalized = normalizeDraft(body.content, body.format ?? 'markdown');
  const id = await upsertDraft(
    user.orgId, user.id, body.id ?? null, body.title?.trim() || 'Untitled draft',
    body.content, normalized.plain, normalized.sha256,
  );
  await appendAudit(user.id, user.orgId, body.id ? AUDIT_ACTIONS.draftEdited : AUDIT_ACTIONS.draftCreated, {
    draftId: id, sha256: normalized.sha256,
  });
  return Response.json({ id, sha256: normalized.sha256, plain: normalized.plain });
}
