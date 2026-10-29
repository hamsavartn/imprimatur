/**
 * Audit chain, application side. The database does the hashing and blocks
 * UPDATE/DELETE; this module only APPENDS events and can VERIFY the chain
 * end to end (used by the settings screen and the exported evidence pack).
 */

import { createHash } from 'node:crypto';

export interface AuditEvent {
  actor: string | null;
  action: string;
  payload: unknown;
}

export interface AuditRow {
  seq: number;
  occurredAt: string;
  actor: string | null;
  action: string;
  payload: unknown;
  prevHash: string;
  rowHash: string;
}

/**
 * Canonical JSON for hashing: keys sorted, no insignificant whitespace.
 * Mirrors the Postgres trigger's payload::text sufficiently for
 * verification because we control both writers.
 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sort);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sort((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(sort(value));
}

export function rowHash(prev: string, ev: { actor: string | null; action: string; occurredAt: string; payload: unknown }): string {
  return createHash('sha256')
    .update(
      `${prev}|${ev.actor ?? ''}|${ev.action}|${ev.occurredAt}|${canonicalJson(ev.payload)}`,
      'utf8',
    )
    .digest('hex');
}

/** Verify a full chain; returns the first break, or null if intact. */
export function verifyChain(rows: AuditRow[]): { ok: boolean; breakAt: number | null; reason?: string } {
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prevHash !== prev) {
      return { ok: false, breakAt: r.seq, reason: `prev_hash mismatch at seq ${r.seq}` };
    }
    const expect = rowHash(prev, {
      actor: r.actor,
      action: r.action,
      occurredAt: r.occurredAt,
      payload: r.payload,
    });
    if (expect !== r.rowHash) {
      return { ok: false, breakAt: r.seq, reason: `row_hash mismatch at seq ${r.seq} (payload or timestamp altered)` };
    }
    prev = r.rowHash;
  }
  return { ok: true, breakAt: null };
}

/** Actions we append; keep the vocabulary small and stable. */
export const AUDIT_ACTIONS = {
  draftCreated: 'draft.created',
  draftEdited: 'draft.edited',
  reviewRun: 'review.run',
  findingResolved: 'finding.resolved',
  approvalGranted: 'approval.grant',
  approvalRevoked: 'approval.revoke',
  factUpserted: 'fact.upsert',
  factExpired: 'fact.expire',
  guidelineEdited: 'guideline.edit',
  userRoleChanged: 'user.role',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
