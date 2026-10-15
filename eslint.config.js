import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'supabase/**'] },
  js.configs.recommended,
  {
    files: ['web/js/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], eqeqeq: 'error', 'no-eval': 'error', 'no-implied-eval': 'error' },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // אסור innerHTML – הגנה מ-XSS
    files: ['web/js/**/*.js'],
    rules: { 'no-restricted-properties': ['error', { property: 'innerHTML' }, { property: 'outerHTML' }, { object: 'document', property: 'write' }] },
  },
];
