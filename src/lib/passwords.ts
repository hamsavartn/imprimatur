/**
 * Password hashing and session tokens. scrypt with a per-user salt, stored
 * as "salt:hash" hex; verification is timing-safe. Session tokens are 48
 * random bytes, stored raw in the session table and set as an httpOnly
 * cookie — the token is the only credential, passwords never leave the
 * verify function.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function newSessionToken(): string {
  return randomBytes(48).toString('hex');
}

export const SESSION_COOKIE = 'imprimatur_session';
export const SESSION_TTL_DAYS = 7;
