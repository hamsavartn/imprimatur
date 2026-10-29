import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, newSessionToken } from '../src/lib/passwords';

describe('passwords and sessions', () => {
  it('round-trips a password', () => {
    const h = hashPassword('demo-password-1');
    expect(verifyPassword('demo-password-1', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
  it('salts every hash differently', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'));
  });
  it('rejects malformed stored hashes', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
  it('session tokens are long and unique', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).toHaveLength(96);
    expect(a).not.toBe(b);
  });
});
