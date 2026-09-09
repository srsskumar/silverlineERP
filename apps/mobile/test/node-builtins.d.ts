/**
 * Ambient declarations for the node builtins used by tests.
 *
 * WHY: TypeScript 6 + `moduleResolution: bundler` with the `react-native`
 * custom condition (inherited from expo/tsconfig.base) refuses to resolve
 * `node:`-prefixed specifiers at typecheck time ("looks like an absolute
 * URI"). At RUNTIME `tsx --test` runs on real node, so the genuine
 * `node:test` / `node:assert/strict` modules are used — these declarations
 * only satisfy `tsc --noEmit`. Keep signatures in sync with actual usage.
 */

declare module "node:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string | Error): void;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    ok(value: unknown, message?: string | Error): void;
    throws(fn: () => unknown, message?: string | Error): void;
  };
  export default assert;
}
