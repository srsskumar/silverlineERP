/**
 * Which catalogue IDs a test file actually runs.
 *
 * Split out of catalogue-coverage.mjs so the rule can be tested without
 * running the report. Coverage used to be any mention of an ID anywhere in a
 * test file, so a row named in a header comment ("Covers E2E-02, 04, 20"), in
 * a note saying where it is really tested, or in a skipped placeholder
 * counted as covered. Now an ID counts only in the title of a `describe(`,
 * `it(` or `test(` that will run.
 */

export const ID = /\b((?:UT|E2E)-[A-Z0-9]+(?:-\d+)?)\b/g;

/** Characters after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/**
 * The source with every comment blanked out, strings and regular
 * expressions kept.
 *
 * Blanked with spaces, so offsets still line up with the original. Strings
 * and regular expressions are walked rather than searched so that a `//`
 * inside a URL, or a quote inside a regex, is not taken for a comment or a
 * string.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let last = "";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " "; i += 1;
      }
      out += "  "; i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "/" && BEFORE_REGEX.has(last))) {
      const close = c;
      let inClass = false;
      out += c; i += 1;
      while (i < source.length) {
        const d = source[i];
        if (d === "\\") { out += d + (source[i + 1] ?? ""); i += 2; continue; }
        if (close === "/") {
          if (d === "\n") break;
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
        } else if (d === close) break;
        out += d; i += 1;
      }
      out += source[i] ?? ""; i += 1;
      last = "x";
      continue;
    }
    out += c; i += 1;
    if (!/\s/.test(c)) last = c;
  }
  return out;
}

/** Index of the parenthesis closing the one at `open`; strings respected. */
function closingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < code.length && code[i] !== c) { if (code[i] === "\\") i += 1; i += 1; }
    } else if (c === "(") depth += 1;
    else if (c === ")") { depth -= 1; if (depth === 0) return i; }
  }
  return code.length;
}

/**
 * The IDs in the titles of the tests in `source` that will run.
 *
 * A call marked `.skip` or `.todo` (or written `xit`/`xdescribe`) is a
 * placeholder, and so is everything inside a skipped `describe`.
 */
export function runnableIds(source) {
  const code = stripComments(source);
  const call = /\b(x?(?:describe|it|test))((?:\.[A-Za-z]+(?:\([^)]*\))?)*)\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/g;
  const skipped = [];
  const titles = [];
  for (const m of code.matchAll(call)) {
    const [whole, fn, modifiers, , title] = m;
    const off = /\.(skip|todo)\b/.test(modifiers) || fn.startsWith("x");
    const open = m.index + whole.indexOf("(", fn.length + modifiers.length);
    if (off) skipped.push([m.index, closingParen(code, open)]);
    titles.push({ at: m.index, title, off });
  }
  const ids = new Set();
  for (const t of titles) {
    if (t.off || skipped.some(([from, to]) => t.at > from && t.at < to)) continue;
    for (const match of t.title.matchAll(ID)) ids.add(match[1]);
  }
  return ids;
}
