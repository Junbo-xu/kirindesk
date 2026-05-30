import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'eslint.config.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'warn',
      // Nest module classes are intentionally empty.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    // Bootstrap and startup files legitimately log to the console.
    files: ['src/main.ts', 'src/database/role-self-check.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
