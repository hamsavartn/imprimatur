'use client';

import { useCallback, useEffect, useState } from 'react';
import { STATE_META, type FindingState } from '@/lib/states';

interface Me { id: string; name: string; email: string; role: 'creator' | 'reviewer' | 'admin' }
interface Preset { id: string; title: string; demonstrates: string; content: string }
interface Finding {
  state: string; start: number; end: number; excerpt: string; explanation: string;
  confidence: number | null; lane: string;
  gateDetail?: Array<{ gate: number; passed: boolean; detail: string }>;
}
interface AuditEntry { seq: number; at: string; actor: string | null; action: string; payload: unknown; rowHash: string }

const PERSONAS = [
  { email: 'priya@meridianflow.dev', label: 'Priya · creator' },
  { email: 'rahul@meridianflow.dev', label: 'Rahul · reviewer' },
  { email: 'admin@meridianflow.dev', label: 'Org admin' },
];

const tone = (s: string) =>
  s === 'human_review' ? 'blue' :
  s === 'contradicts_fact' || s === 'sources_conflict' ? 'red' :
  s === 'compliant' ? 'green' : 'amber';

function stateLabel(s: string) {
  if (s === 'human_review') return 'Needs a human';
  return STATE_META[s as FindingState]?.label ?? s;
}

export default function Workbench() {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<{ providerLabel: string; confidentialMode: boolean } | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState<string>('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [sha, setSha] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [runInfo, setRunInfo] = useState<{ lane: string; durationMs: number; degradation: string[] } | null>(null);
  const [approved, setApproved] = useState(false);
  const [audit, setAudit] = useState<{ entries: AuditEntry[]; chain: { ok: boolean; reason?: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const s = await fetch('/api/status').then((r) => r.json());
      setStatus(s);
      const p = await fetch('/api/demo').then((r) => r.json());
      setPresets(p.presets ?? []);
    } catch { /* server offline */ }
    try {
      const meRes = await fetch('/api/me').then((r) => (r.ok ? r.json() : null));
      setMe(meRes?.user ?? null);
    } catch { /* not signed in */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadDraft = async (id: string) => {
    const data = await fetch(`/api/drafts/${id}`).then((r) => r.json());
    if (data.error) return;
    setDraftId(id);
    setTitle(data.draft.title);
    setContent(data.draft.content);
    setSha(data.draft.draft_sha256);
    setFindings((data.findings ?? []).map((f: Finding & { start_offset: number; end_offset: number }) => ({
      ...f, start: f.start_offset, end: f.end_offset,
    })));
    setApproved(Boolean(data.approvedNow));
  };

  const signIn = async (email: string) => {
    setMsg('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'demo-password-1' }),
    });
    if (!res.ok) {
      const data = await res.json();
      setMsg(`Sign-in failed: ${data.error ?? 'unknown error'}`);
      return;
    }
    await refresh();
    const list = await fetch('/api/drafts').then((r) => (r.ok ? r.json() : { drafts: [] }));
    if (list.drafts?.length) await loadDraft(list.drafts[0].id);
  };

  const usePreset = (p: Preset) => {
    setPresetId(p.id);
    setTitle(p.title);
    setContent(p.content);
    setFindings([]);
    setApproved(false);
    setDraftId(null);
  };

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: draftId ?? undefined, title, content, format: 'markdown' }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? 'Could not save.'); return; }
      setDraftId(data.id);
      setSha(data.sha256);
      setMsg('Draft saved. Content hash recorded.');
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!draftId) { setMsg('Save the draft first.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/drafts/${draftId}/review`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? 'Review failed.'); return; }
      setFindings(data.findings);
      setRunInfo({ lane: data.lane, durationMs: data.durationMs, degradation: data.degradation ?? [] });
      setMsg(`Review complete: ${data.findings.length} findings in ${data.durationMs} ms (${data.lane} lane).`);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!draftId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      setMsg(res.ok
        ? `Decision recorded, bound to content hash ${String(data.boundSha256).slice(0, 12)}…`
        : `Blocked: ${data.error}`);
      if (res.ok) setApproved(decision === 'approved');
    } finally {
      setBusy(false);
    }
  };

  const showAudit = async () => {
    const data = await fetch('/api/audit').then((r) => r.json());
    if (data.entries) setAudit({ entries: data.entries, chain: data.chain });
  };

  const blocking = findings.filter((f) => f.state !== 'compliant' && f.state !== 'promotional_puffery');

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <span className="live-dot" aria-hidden="true" />
          <h1>Imprimatur</h1>
          <span className="sub">brand-governance review gate · Meridian Flow workspace</span>
        </div>
        <div className="persona">
          <span className="who">{me ? `${me.name} (${me.email})` : 'not signed in'}</span>
          {PERSONAS.map((p) => (
            <button key={p.email} className={me?.email === p.email ? 'active' : ''} onClick={() => void signIn(p.email)}>
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {status && (
        <div className={`banner ${status.confidentialMode ? 'warn' : 'info'}`}>
          Model provider: {status.providerLabel}. External model use is disclosed per review; the deterministic lane runs
          with or without it.
        </div>
      )}
      {msg && <div className="banner ok">{msg}</div>}
      {runInfo?.degradation?.map((d, i) => (
        <div key={i} className="banner warn">{d}</div>
      ))}

      <div className="grid">
        <div className="card">
          <h2>Draft</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <input type="text" placeholder="Draft title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <textarea className="editor" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste or write the draft here (markdown)…" />
          <div className="meta-line">
            {sha ? <>content hash <span className="sha">{sha.slice(0, 24)}…</span>{approved && <> · <b style={{ color: 'var(--green)' }}>approved at this hash</b></>}</> : 'not saved yet'}
          </div>
          <div className="row">
            <button onClick={() => void save()} disabled={busy || !content.trim()}>Save draft</button>
            <button className="primary" onClick={() => void review()} disabled={busy || !draftId}>Run review</button>
            {me && (me.role !== 'creator') && (
              <>
                <button className="primary" onClick={() => void decide('approved')} disabled={busy || blocking.length > 0 || approved}>
                  Approve {blocking.length > 0 ? `(blocked: ${blocking.length} open findings)` : ''}
                </button>
                <button className="danger" onClick={() => void decide('rejected')} disabled={busy}>Reject</button>
              </>
            )}
            <button className="ghost" onClick={() => void showAudit()}>Audit trail</button>
          </div>
          <p className="why" style={{ marginTop: 10 }}>
            Editing a saved draft changes its content hash, and approvals bound to the old hash stop working. That rule
            is enforced server-side, not by this page.
          </p>
        </div>

        <div className="card">
          <h2>Findings</h2>
          {findings.length === 0 && <p className="empty">No review yet. Pick a preset, save, and run the review.</p>}
          {findings.map((f, i) => (
            <div key={i} className={`finding ${tone(f.state)}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className={`chip ${tone(f.state)}`}>{stateLabel(f.state)}</span>
                <span className="chip gray">{f.lane === 'deterministic' ? 'rules' : 'grounding'}</span>
              </div>
              <p className="excerpt">“{f.excerpt}”</p>
              <p className="why">{f.explanation}</p>
              {f.gateDetail && f.gateDetail.length > 0 && (
                <div className="gates">
                  {f.gateDetail.map((g, j) => (
                    <div key={j} className="g">
                      <b className={g.passed ? 'ok' : 'no'}>Gate {g.gate} {g.passed ? 'pass' : 'fail'}</b>
                      <span>{g.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid section-gap">
        <div className="card">
          <h2>Demo presets</h2>
          <div className="presets">
            {presets.map((p) => (
              <button key={p.id} className={`preset ${presetId === p.id ? 'active' : ''}`} onClick={() => usePreset(p)}>
                {p.title}
                <small>{p.demonstrates}</small>
              </button>
            ))}
          </div>
          <p className="why">Presets load into the editor; save then review. The reviewer persona approves; the creator
          persona cannot (role gating is server-side).</p>
        </div>

        <div className="card drawer">
          <h2>Audit trail (hash-chained)</h2>
          {!audit && <p className="empty">Every action appends a row; UPDATE and DELETE are rejected by the database. Open the trail to verify the chain.</p>}
          {audit && (
            <>
              <div className={`banner ${audit.chain.ok ? 'ok' : 'warn'}`} style={{ marginBottom: 10 }}>
                {audit.chain.ok
                  ? `Chain verified: ${audit.entries.length} entries, hashes intact end to end.`
                  : `CHAIN BROKEN at seq ${audit.chain.reason ?? ''}`}
              </div>
              {audit.entries.slice().reverse().slice(0, 12).map((e) => (
                <div key={e.seq} className="audit-entry">
                  <b>#{e.seq}</b> {e.action} · {new Date(e.at).toLocaleTimeString()}
                  <div className="h">{e.rowHash.slice(0, 32)}…</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
