/**
 * One rule, and a reason for it.
 *
 * This project checks types and runs a large unit suite, and neither can see
 * a hooks-order violation: `tsc` has no idea that a `useMemo` below an early
 * return runs on some renders and not others, and the unit tests never mount
 * a component. The Villages tab — the most-used screen in the survey module —
 * shipped to production dead because of exactly that, and every gate we had
 * went green.
 *
 * So: the purpose-built rule, as an error, over the application code. It is
 * deliberately the only rule configured. A hundred style warnings nobody
 * clears would bury the one finding that matters, and this file exists to
 * stop one specific way of breaking a screen.
 */
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      /*
       * Stubs, so inline disables naming rules from an older setup resolve.
       * An unresolvable rule name in a disable comment is itself reported as
       * an error, which would leave this check permanently red for reasons
       * that have nothing to do with hooks.
       */
      '@typescript-eslint': { rules: { 'no-explicit-any': { create: () => ({}) } } },
      react: { rules: { 'no-array-index-key': { create: () => ({}) } } },
    },
    languageOptions: {
      parser: (await import('@typescript-eslint/parser')).default,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      /*
       * The codebase carries inline disables for rules this config does not
       * turn on — exhaustive-deps and a few style rules from whatever setup
       * existed before. Reporting them would fill the output with noise about
       * comments, and the one thing this check exists to find would scroll
       * off the top.
       */
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Calling a hook conditionally, in a loop, or after an early return.
      'react-hooks/rules-of-hooks': 'error',
      // Declared only so the inline disables scattered through the codebase
      // resolve to something. Off: this file is about one rule.
      'react-hooks/exhaustive-deps': 'off',
      // Same reason: inline disables elsewhere name these, and an
      // unresolvable rule name is itself reported as an error.
      '@typescript-eslint/no-explicit-any': 'off',
      'react/no-array-index-key': 'off',
    },
  },
];
