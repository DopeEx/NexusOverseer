import js from '@eslint/js';
import globals from 'globals';
import css from '@eslint/css';
import html from '@html-eslint/eslint-plugin';

const coreJsRulesOff = Object.fromEntries(
  Object.keys(js.configs.recommended.rules).map(rule => [rule, 'off'])
);

export default [
  js.configs.recommended,
  {
    rules: { 'no-unused-vars': 'warn' }
  },
  {
    files: ['nexus-addon/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, Chart: 'readonly' },
    },
  },
  {
    files: ['tests/**/*.js', 'tools/demo/server.js', 'tools/galaxy-data.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    },
  },
  {
    files: ['tools/demo/browser.js', 'tools/demo/fixtures.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['nexus-addon/**/*.css'],
    plugins: { css },
    language: 'css/css',
    rules: {
      ...coreJsRulesOff,
      'css/no-duplicate-imports': 'error',
      'css/no-empty-blocks': 'warn',
    },
  },
  {
    files: ['nexus-addon/**/*.html'],
    ...html.configs['flat/recommended'],
    rules: {
      ...coreJsRulesOff,
      '@html-eslint/require-doctype': 'error',
      '@html-eslint/no-duplicate-attrs': 'error',
    },
  },
  {
    ignores: ['reference/**', 'nexus-addon/chart.umd.js', 'nexus-addon/browser-polyfill.js']
  },
];
