import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * Flat config. The rules here are the executable form of docs/guidelines/*.
 */
export default defineConfig(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'docs/api/**',
      // The documentation site's Python environment and build output (ADR-0020).
      'docs/.venv/**',
      'docs/site/_build/**',
      'docs/site/api/reference/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The flat config itself is not part of the TypeScript program, but it is still
          // linted; without this, type-aware rules cannot resolve it.
          allowDefaultProject: ['eslint.config.js'],
        },
      },
    },
    plugins: { 'import-x': importX },
    rules: {
      // --- Type safety (docs/guidelines/typescript.md) ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // A type argument of `void` is how "a promise that resolves with nothing" is spelled;
      // the rule's real objection, `void` in unions and parameters, stays banned.
      '@typescript-eslint/no-invalid-void-type': ['error', { allowInGenericTypeArguments: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a const object + union type instead of enum.',
        },
        { selector: 'TSModuleDeclaration[kind="namespace"]', message: 'Use ES modules.' },
      ],

      // --- Async correctness (docs/guidelines/review-checklist.md) ---
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // --- Defensive programming (docs/guidelines/defensive-programming.md) ---
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // --- Environment injection (ADR-0014) ---
      'no-restricted-globals': [
        'error',
        { name: 'navigator', message: 'Use the injected SerialBrokerEnvironment (ADR-0014).' },
        { name: 'window', message: 'Use the injected SerialBrokerEnvironment (ADR-0014).' },
        { name: 'localStorage', message: 'Use environment.storage (ADR-0014).' },
        { name: 'setTimeout', message: 'Use environment.clock (ADR-0014).' },
        { name: 'clearTimeout', message: 'Use environment.clock (ADR-0014).' },
        { name: 'setInterval', message: 'Use environment.clock (ADR-0014).' },
        { name: 'clearInterval', message: 'Use environment.clock (ADR-0014).' },
      ],

      // --- Module boundaries (docs/guidelines/coding-style.md) ---
      'import-x/no-cycle': ['error', { maxDepth: Infinity }],
      'import-x/no-default-export': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // The composition root is the single place allowed to touch browser globals (ADR-0014).
  {
    files: ['src/environment/browser.ts', 'src/worker/serial-broker.worker.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },

  // The debugging surface is an application page, and like any application it is its own
  // composition root: it reads navigator, storage and timers directly, as src/environment/browser.ts
  // does for the library (ADR-0019).
  {
    files: ['debug/**/*.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },

  // Test code answers to different constraints than the library it tests.
  //
  // A fake implements an interface it does not need all of: an `async` method with no `await`
  // is how a stand-in satisfies a signature the real thing needs. A test matrix deletes
  // computed keys to build every malformed variant of a message. An assertion the compiler
  // calls redundant is often the thing documenting what a test is deliberately violating.
  // And the harness needs real timers to let promise chains run, which is precisely what the
  // library must never do.
  //
  // None of these relaxations apply to `src/`, where every one of these rules is on.
  {
    files: ['test/**/*.ts', 'emulator/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // The documentation build script is plain Node JavaScript with no TypeScript program behind it,
  // so rules that need type information cannot apply to it (ADR-0020).
  {
    files: ['docs/site/build.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly' } },
  },

  // The documentation's examples are application code shown to readers: they log to the
  // console and use browser globals directly, as the applications they stand for would.
  {
    files: ['docs/site/examples/code/**/*.ts'],
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },

  // Config files are Node-side and use default exports by convention.
  {
    files: ['*.config.ts', '*.config.js', 'eslint.config.js'],
    rules: {
      'import-x/no-default-export': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  prettier,
);
