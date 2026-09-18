import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/*
 * Two suites, because they need different worlds.
 *
 * `tests/` is pure logic — formatters, filters, arithmetic — and runs in node,
 * which is fast and has no DOM to set up. `tests-dom/` mounts real components
 * and needs jsdom.
 *
 * The second suite exists because of a specific failure: the Villages tab
 * shipped to production throwing "rendered more hooks than during the previous
 * render", and a green typecheck, a green build and 1,700 passing tests all
 * missed it — because nothing rendered a component. A lint rule now catches
 * that one mistake; these catch the next one, whatever shape it takes.
 */
export default defineConfig({
  // esbuild's automatic runtime rather than the React plugin: the plugin in
  // this tree wants a newer Vite than the repo pins, and nothing here needs
  // fast refresh.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    // No top-level include or environment: each project below defines its
    // own, and anything set here would be inherited into both.
    projects: [
      {
        extends: true,
        test: {
          name: 'logic',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests-dom/**/*.test.tsx'],
          setupFiles: ['./tests-dom/setup.ts'],
        },
      },
    ],
  },
});
