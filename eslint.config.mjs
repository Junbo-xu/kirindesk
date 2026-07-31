import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  Buffer: 'readonly',
  URL: 'readonly',
  __dirname: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const browserGlobals = {
  Blob: 'readonly',
  FormData: 'readonly',
  URL: 'readonly',
  console: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  window: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-extraneous-class': 'off',
      'no-console': 'warn',
    },
  },
  {
    files: ['apps/{web,admin}/**/*.{ts,tsx}', 'playwright.config.ts'],
    languageOptions: { globals: browserGlobals },
  },
  {
    files: [
      'apps/api/src/main.ts',
      'apps/api/src/database/role-self-check.ts',
      'packages/database/src/*.ts',
      'src/migrate.ts',
      'src/rollback.ts',
      'src/rehearse.ts',
      'src/seed.ts',
      'src/verify-chain.ts',
      'scripts/*.mjs',
    ],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
