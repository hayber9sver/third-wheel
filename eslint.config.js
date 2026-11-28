// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '.venv*/',
      '**/dist/',
      '**/dist-electron/',
      '**/out/',
      '**/release/', // installers
      '**/build/',
      '**/coverage/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // packages/core is pure TS — no DOM, three.js or Electron.
    files: ['packages/core/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'packages/core must not import three.js.' },
            {
              group: ['electron', 'electron/*'],
              message: 'packages/core must not import Electron.',
            },
          ],
        },
      ],
    },
  },
  {
    // Core code (not its tests) does no I/O: callers pass Node's `path` / a file system.
    files: ['packages/core/**/*.ts'],
    ignores: ['packages/core/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'packages/core must not import three.js.' },
            {
              group: ['electron', 'electron/*'],
              message: 'packages/core must not import Electron.',
            },
            {
              group: ['node:*', 'fs', 'path', 'os'],
              message: 'packages/core does no I/O: take a PathApi / ProjectFs from the caller.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
