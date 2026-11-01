// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const TEMPLATES = ['ordering', 'payments', 'pos', 'logistics'];

/**
 * No cross-app coupling: a template may import only @aod/shared and its own files.
 * Every other template (by package name or by relative path) is off limits.
 */
const crossTemplateRules = TEMPLATES.map((app) => {
  const others = TEMPLATES.filter((t) => t !== app);
  return {
    files: [`templates/${app}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: others.flatMap((o) => [`@aod/template-${o}`, `@aod/template-${o}/*`, `**/templates/${o}/**`, `../../${o}/**`, `../${o}/**`]),
              message: 'Templates must not import other templates (no cross-app coupling). Communicate through events.',
            },
            {
              group: ['@aod/server', '@aod/server/*', '**/apps/server/**'],
              message: 'Templates depend on @aod/shared contracts only, never on the server internals.',
            },
          ],
        },
      ],
    },
  };
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  ...crossTemplateRules,
  // Promise safety (skill: promise-safety). Type-aware: every promise is awaited, returned
  // or has a rejection handler. On the server an unhandled rejection kills the process
  // (API and every worker), so `void` alone does not count as handling there.
  {
    files: ['apps/server/**/*.ts', 'packages/**/*.ts', 'templates/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // In the browser `void` marks a deliberate fire-and-forget (navigation, cache invalidation).
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // React Aria's onPress/onSubmit accept async handlers.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
);
