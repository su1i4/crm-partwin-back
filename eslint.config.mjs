// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='getRepository'][arguments.length=1]",
          message:
            'Прямой доступ к репозиторию запрещён (ТЗ 2.4.5). Используйте TenantTransaction / TenantRepository. Для global_* и платформенных таблиц — PlatformDb.',
        },
      ],
    },
  },
);
