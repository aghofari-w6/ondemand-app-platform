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
);
