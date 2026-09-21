import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boardViewHref } from '../lib/routes';

/**
 * The board's "list" switch sent people to /projects/<id>/tasks, a route that
 * has never existed -- only /projects/<id>/tasks/<taskId> does -- and it built
 * the address by hand, past staticHref, so even a real page would have missed
 * the static host.
 */
describe('switching the board to the list', () => {
  it('goes to the project page, through the static route', () => {
    expect(boardViewHref('p1', 'list')).toBe('/record?type=project&id=p1');
    expect(boardViewHref('p1', 'board')).toBe('/record?type=board&id=p1');
  });

  it('is never built by hand as /projects/<id>/tasks anywhere in the app', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', '.next', '.next-verify', 'tests', 'tests-dom'].includes(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)
          && /\/projects\/\$\{[^}]+\}\/tasks[`'"]/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full.slice(root.length));
        }
      }
    };
    for (const dir of ['app', 'components', 'lib']) walk(join(root, dir));
    expect(offenders).toEqual([]);
  });
});
