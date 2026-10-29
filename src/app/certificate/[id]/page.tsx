import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { getDraft } from '@/db/repo';
import { sql } from '@/db/client';

export const dynamic = 'force-dynamic';

/** Printable compliance certificate (server-rendered from persisted state). */
export default async function CertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user?.orgId) redirect('/');
  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft || draft.org_id !== user.orgId) redirect('/');

  const active = await sql<Array<{ decided_at: string; draft_sha256: string; name: string; role: string }>>`
    SELECT a.decided_at::text, a.draft_sha256, u.name, u.role
    FROM approval a JOIN "user" u ON u.id = a.decided_by
    WHERE a.draft_id = ${id} AND a.decision = 'approved' AND a.revoked_at IS NULL
      AND a.draft_sha256 = ${draft.draft_sha256}
    ORDER BY a.decided_at DESC LIMIT 1`;
  const run = await sql<Array<{ id: string; lane: string; duration_ms: number | null }>>`
    SELECT id, lane, duration_ms FROM review_run
    WHERE draft_id = ${id} AND draft_sha256 = ${draft.draft_sha256} AND finished_at IS NOT NULL
    ORDER BY started_at DESC LIMIT 1`;
  const findings = run[0]
    ? await sql<Array<{ state: string; count: number }>>`
        SELECT state, count(*)::int AS count FROM finding WHERE run_id = ${run[0].id} GROUP BY state`
    : [];
  const chain = await sql<Array<{ ok: boolean }>>`SELECT ok FROM audit_verify_chain()`;

  const a = active[0];
  return (
    <div style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'Georgia, serif', color: '#1c2430', padding: '0 16px' }}>
      <div style={{ border: '3px double #1a3a5c', padding: 32 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: 2, color: '#5b6774' }}>IMPRIMATUR · COMPLIANCE CERTIFICATE</div>
          <h1 style={{ fontSize: 24, margin: '16px 0 4px' }}>{draft.title}</h1>
          <div style={{ fontSize: 13, color: '#5b6774' }}>Approved version · content hash</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, margin: '4px 0 20px' }}>{draft.draft_sha256}</div>
        </div>
        {a ? (
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <tbody>
              <tr><td style={td(1)}>Approved by</td><td style={td(0)}>{a.name} ({a.role})</td></tr>
              <tr><td style={td(1)}>Decision recorded</td><td style={td(0)}>{new Date(a.decided_at).toUTCString()}</td></tr>
              <tr><td style={td(1)}>Bound to hash</td><td style={td(0)}><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.draft_sha256.slice(0, 32)}…</span></td></tr>
              <tr><td style={td(1)}>Review</td><td style={td(0)}>{run[0] ? `${run[0].lane} lane · ${Object.entries(Object.fromEntries(findings.map((f) => [f.state, f.count]))).map(([k, v]) => `${v} ${k}`).join(', ') || 'no findings'}` : 'no completed review'}</td></tr>
              <tr><td style={td(1)}>Audit chain</td><td style={td(0)}>{chain[0]?.ok ? 'verified intact' : 'VERIFICATION FAILED'}</td></tr>
            </tbody>
          </table>
        ) : (
          <p style={{ fontSize: 14 }}>No active approval is bound to the current content hash. Approve the current version to issue a certificate.</p>
        )}
        <p style={{ fontSize: 11, color: '#5b6774', marginTop: 24 }}>
          This certificate attests that the content identified by the hash above completed the recorded review and
          received the recorded approval. It does not attest that the underlying approved sources are factually
          correct, and it does not establish issuer identity beyond the recorded account. Any edit to the content
          invalidates this certificate by hash mismatch.
        </p>
      </div>
      <p style={{ fontSize: 12, color: '#5b6774', textAlign: 'center' }}>Use your browser&apos;s print function to export this page as PDF.</p>
    </div>
  );
}

function td(border: number): React.CSSProperties {
  return { border: border ? '1px solid #d8dfe6' : 'none', padding: '6px 10px 6px 0', verticalAlign: 'top' };
}
