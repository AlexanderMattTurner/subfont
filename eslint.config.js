const neostandard = require('neostandard');
const eslintConfigPrettier = require('eslint-config-prettier');
const mochaPlugin = require('eslint-plugin-mocha');
const tseslint = require('typescript-eslint');
const globals = require('globals');
const regexpPlugin = require('eslint-plugin-regexp');

module.exports = [
  ...neostandard(),
  eslintConfigPrettier,
  regexpPlugin.configs['flat/recommended'],
  {
    plugins: {
      mocha: mochaPlugin,
    },
    rules: {
      'prefer-template': 'error',
      // Forbid index-based regex group access: every capturing group must be
      // named, so matches are read via `m.groups.name` instead of `m[1]`.
      'prefer-named-capture-group': 'error',
      'mocha/no-exclusive-tests': 'error',
      'mocha/no-nested-tests': 'error',
      'mocha/no-identical-title': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: globals.mocha,
    },
  },
  // TypeScript source: forbid explicit `any` and `unknown`. Both are
  // permitted in .d.ts shims for untyped deps (see next config block) and
  // can be opted into per-line with `// eslint-disable-next-line` when
  // the boundary is genuinely opaque (catch clauses, variadic args, WASM
  // exports, generic worker payloads).
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
      'no-void': ['error', { allowAsStatement: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSUnknownKeyword',
          message:
            'Avoid `unknown`; specify a concrete type. If the value is genuinely opaque, disable this line with an eslint-disable-next-line comment.',
        },
      ],
      // TypeScript's own checker handles undefined identifiers, including
      // built-in globals like Console / NodeJS that ESLint's no-undef
      // doesn't recognise.
      'no-undef': 'off',
    },
  },
  {
    // .d.ts ambient shims for untyped dependencies — `any`/`unknown` are
    // the right tools here; tightening would require typing the deps
    // themselves.
    files: ['src/**/*.d.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-restricted-syntax': 'off',
      'no-undef': 'off',
    },
  },
  {
    ignores: [
      'testdata/',
      'node_modules/',
      'coverage/',
      'vendor/',
      'puppeteer-browsers/',
      // Compiled TypeScript output — source lives under src/.
      'lib/',
      // Mutation-testing artifacts (Stryker sandbox + reports).
      '.stryker-tmp/',
      'reports/',
      // CI helper scripts and Claude hooks owned by the template repo and
      // overwritten wholesale on every sync, so fixes made here do not survive:
      // the next sync would re-break `pnpm test` and with it the publish job.
      // They are written against the template's own lint config, which does not
      // carry this repo's prefer-named-capture-group or regexp/* rules.
      // Excluding matches punctilio, the sibling repo on the same template,
      // whose lint script is scoped to `src scripts`. Every JS file under
      // .claude/hooks/ is template-owned; the repo's own hooks there are shell
      // and Python, which ESLint does not read.
      '.github/scripts/',
      '.claude/hooks/',
    ],
  },
];
