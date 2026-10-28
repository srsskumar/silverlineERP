import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The static export's security headers (public/_headers).
 *
 * The Permissions-Policy used to say geolocation=(), which a browser reads
 * as "nobody, not even this page" -- so the punch clock's position request
 * was refused before the person was ever asked, and every web punch went in
 * without a location.
 */
const HEADERS = readFileSync(fileURLToPath(new URL('../public/_headers', import.meta.url)), 'utf8');

function policy(): Map<string, string> {
  const line = HEADERS.split('\n').find((l) => l.trim().startsWith('Permissions-Policy:'));
  expect(line, 'Permissions-Policy is set').toBeTruthy();
  const value = line!.split(':').slice(1).join(':');
  return new Map(value.split(',').map((d) => {
    const [name, allow] = d.trim().split('=');
    return [name, allow] as [string, string];
  }));
}

describe('Permissions-Policy', () => {
  it('lets this origin ask for the position the punch clock needs', () => {
    expect(policy().get('geolocation')).toBe('(self)');
  });

  it('keeps everything else it does not use switched off', () => {
    const p = policy();
    for (const feature of ['camera', 'microphone', 'payment', 'usb']) {
      expect(p.get(feature), feature).toBe('()');
    }
  });
});

/*
 * Vercel ignores public/_headers (a Cloudflare Pages format), so for a
 * month the production deployment shipped with no Content-Security-Policy
 * at all while this file said it had one (security review D-1, 2026-10-28).
 * Both carriers must say the same thing.
 */
import vercel from '../vercel.json';

function vercelHeader(name: string): string | undefined {
  const all = (vercel as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> }).headers
    .find((h) => h.source === '/(.*)')?.headers ?? [];
  return all.find((h) => h.key === name)?.value;
}

function cloudflareHeader(name: string): string | undefined {
  const line = HEADERS.split('\n').find((l) => l.trim().startsWith(name + ':'));
  return line?.split(':').slice(1).join(':').trim();
}

describe('the Vercel deployment carries the same security headers', () => {
  it('has a Content-Security-Policy that is not open to any origin', () => {
    const csp = vercelHeader('Content-Security-Policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/connect-src[^;]*\shttps:(\s|;|$)/);
    expect(csp).toBe(cloudflareHeader('Content-Security-Policy'));
  });

  it('isolates the browsing context and pins the rest', () => {
    expect(vercelHeader('Cross-Origin-Opener-Policy')).toBe('same-origin');
    for (const name of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
      expect(vercelHeader(name), name).toBe(cloudflareHeader(name));
    }
  });
});
