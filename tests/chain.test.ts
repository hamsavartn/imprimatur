import { describe, expect, it } from 'vitest';
import { canonicalJson, rowHash, verifyChain, type AuditRow } from '../src/lib/audit/chain';

function chainOf(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = 'GENESIS';
  for (let i = 0; i < n; i++) {
    const occurredAt = new Date(1700000000000 + i * 1000).toISOString();
    const ev = { actor: 'u1', action: 'review.run', occurredAt, payload: { seq: i, draft: 'd1' } };
    const hash = rowHash(prev, ev);
    rows.push({ seq: i + 1, occurredAt, actor: 'u1', action: 'review.run', payload: { seq: i, draft: 'd1' }, prevHash: prev, rowHash: hash });
    prev = hash;
  }
  return rows;
}

describe('audit chain', () => {
  it('verifies an intact chain', () => {
    expect(verifyChain(chainOf(20)).ok).toBe(true);
  });
  it('detects a mutated payload', () => {
    const rows = chainOf(20);
    rows[7].payload = { seq: 999 };
    const v = verifyChain(rows);
    expect(v.ok).toBe(false);
    expect(v.breakAt).toBe(8);
  });
  it('detects a deleted row (link break)', () => {
    const rows = chainOf(20);
    rows.splice(4, 1);
    expect(verifyChain(rows).ok).toBe(false);
  });
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('approval workflow', () => {
  it('creator cannot approve; reviewer can', async () => {
    const { recordDecision, UnauthorizedApprovalError } = await import('../src/lib/workflow/approval');
    expect(() => recordDecision('d', 'h', { id: 'u', role: 'creator' }, 'approved', undefined)).toThrow(UnauthorizedApprovalError);
    expect(() => recordDecision('d', 'h', { id: 'u', role: 'reviewer' }, 'approved', undefined)).not.toThrow();
  });
  it('an edited draft blocks acting on the old approval', async () => {
    const { recordDecision, assertApprovalActionable, StaleApprovalError } = await import('../src/lib/workflow/approval');
    const a = recordDecision('d', 'hash-1', { id: 'u', role: 'reviewer' }, 'approved', undefined);
    expect(() => assertApprovalActionable(a, 'hash-2')).toThrow(StaleApprovalError);
    expect(() => assertApprovalActionable(a, 'hash-1')).not.toThrow();
  });
  it('override rationales must be substantive', async () => {
    const { recordDecision } = await import('../src/lib/workflow/approval');
    expect(() => recordDecision('d', 'h', { id: 'u', role: 'reviewer' }, 'approved', 'ok')).toThrow();
  });
  it('knowledge changes flag exactly the affected approved drafts', async () => {
    const { flagsFor } = await import('../src/lib/workflow/flags');
    const drafts = [
      { draftId: 'd1', draftSha256: 'x', isApproved: true, citedFactKeys: ['pricing/basic-plan'] },
      { draftId: 'd2', draftSha256: 'y', isApproved: true, citedFactKeys: ['security/encryption'] },
      { draftId: 'd3', draftSha256: 'z', isApproved: false, citedFactKeys: ['pricing/basic-plan'] },
    ];
    const flags = flagsFor(drafts, { kind: 'fact_edited', ref: 'pricing/basic-plan' });
    expect(flags.map((f) => f.draftId)).toEqual(['d1']);
    expect(flagsFor(drafts, { kind: 'guideline_edited', ref: 'g1' }).map((f) => f.draftId).sort()).toEqual(['d1', 'd2']);
  });
});
