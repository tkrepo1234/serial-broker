import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

/**
 * Flat config. The rules here are the executable form of docs/guidelines/*.
 */
export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'docs/api/**'] },

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

  // Tests may assert on shapes that are deliberately loose, and may use non-null assertions
  // where the arrangement guarantees the value.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
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
