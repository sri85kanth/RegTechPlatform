// Guard: production code may not import seed/fixture data or reach for static
// regulatory JSON. Regulatory data has exactly one path: the API.
//
// Run:  npx eslint --config eslint.config.guard.mjs "src/**/*.{ts,tsx}"
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/__fixtures__/**'],
    // Without a TS parser every file is a parse error and the rules below never
    // run — a guard that silently passes is worse than no guard.
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // registered only so existing inline disable-comments resolve
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/__fixtures__/**'], message: 'Fixtures are test-only and must never reach production code.' },
          { group: ['**/regSeed*'], message: 'Regulatory data comes from /api/regulations, never from seed.' },
          { group: ['**/.retired/**'], message: 'Retired seed modules must not be re-imported.' },
        ],
      }],
      // Block any fetch of a build-time JSON asset, the other route seed data took.
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.name='fetch'] > Literal[value=/\\/data\\/.*\\.json/]",
        message: 'Static JSON is not a data source. Fetch from the API (API_BASE) instead.',
      }, {
        selector: "CallExpression[callee.name='fetch'] > TemplateLiteral > TemplateElement[value.raw=/\\/data\\/.*\\.json/]",
        message: 'Static JSON is not a data source. Fetch from the API (API_BASE) instead.',
      }],
    },
  },
];
