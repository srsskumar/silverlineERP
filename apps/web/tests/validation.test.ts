import { describe, expect, it } from 'vitest';
import { loginSchema, mfaSchema } from '../lib/validation';

describe('loginSchema', () => {
  it('accepts a valid username and password', () => {
    const result = loginSchema.safeParse({ username: 'asha.k', password: 's3cret-pass' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty username', () => {
    const result = loginSchema.safeParse({ username: '', password: 's3cret-pass' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.username).toContain('Username is required');
    }
  });

  it('rejects an empty password', () => {
    const result = loginSchema.safeParse({ username: 'asha.k', password: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.password).toContain('Password is required');
    }
  });

  it('rejects a username longer than 100 characters', () => {
    const result = loginSchema.safeParse({ username: 'a'.repeat(101), password: 's3cret-pass' });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(loginSchema.safeParse({}).success).toBe(false);
  });
});

describe('mfaSchema', () => {
  it('accepts a 6-digit code', () => {
    expect(mfaSchema.safeParse({ token: '123456' }).success).toBe(true);
  });

  it('rejects a 5-digit code', () => {
    const result = mfaSchema.safeParse({ token: '12345' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric codes', () => {
    expect(mfaSchema.safeParse({ token: 'abcdef' }).success).toBe(false);
  });

  it('rejects codes longer than 6 digits', () => {
    expect(mfaSchema.safeParse({ token: '1234567' }).success).toBe(false);
  });

  it('rejects an empty code', () => {
    expect(mfaSchema.safeParse({ token: '' }).success).toBe(false);
  });
});
