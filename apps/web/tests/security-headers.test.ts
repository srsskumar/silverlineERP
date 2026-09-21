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
