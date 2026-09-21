import { describe, expect, it } from 'vitest';
import { runnableIds } from '../../../scripts/catalogue-ids.mjs';

/**
 * What counts as covering a catalogue row (CAT-1).
 *
 * Any mention of an ID in a test file used to count, so a row named in a
 * header comment, or in a skipped placeholder, read as tested.
 */
describe('the catalogue coverage rule', () => {
  const ids = (source: string) => [...runnableIds(source)].sort();

  it('counts an ID in the title of a test that runs', () => {
    expect(ids(`describe("UT-AUTH-01 sign in", () => { it("works", () => {}); });`)).toEqual(['UT-AUTH-01']);
    expect(ids(`it('E2E-04 opens the map', () => {});`)).toEqual(['E2E-04']);
    expect(ids('test(`UT-GEO-02 inside`, () => {});')).toEqual(['UT-GEO-02']);
  });

  it('ignores an ID that is only in a comment or the body', () => {
    expect(ids(`
      /** Covers E2E-02, E2E-20 and UT-OPS-03. */
      // UT-OPS-04
      describe("fences", () => {
        it("keeps the id out of the title", () => { const note = "UT-GEO-09"; expect(note).toBeTruthy(); });
      });`)).toEqual([]);
  });

  it('ignores skipped and to-do tests, and everything in a skipped describe', () => {
    expect(ids(`
      it.skip("UT-ATT-01 not yet", () => {});
      it.todo("UT-ATT-02 later");
      xit("UT-ATT-03 off", () => {});
      describe.skip("UT-ATT-04 parked", () => { it("UT-ATT-05 inside", () => {}); });
      describe("UT-ATT-06 live", () => { it("UT-ATT-07 runs", () => {}); });`)).toEqual(['UT-ATT-06', 'UT-ATT-07']);
  });

  it('is not fooled by a URL or a quote inside a regular expression', () => {
    expect(ids(`
      const url = "https://example.com//x";
      const re = /["']/;
      it("UT-WORK-01 still found", () => { expect(url).toMatch(re); });`)).toEqual(['UT-WORK-01']);
  });
});
