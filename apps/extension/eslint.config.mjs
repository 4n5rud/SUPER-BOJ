import tseslint from 'typescript-eslint';

export default [
  { ignores: ['.wxt/**', '.output/**'] },
  ...tseslint.configs.recommended,
];
