// ESLint 平面配置：覆盖前端（app/src）与核心（src / tests / tools）的 TypeScript 源码。
// 只做静态纠错与风格底线，不做类型级规则（类型检查由 tsc 负责，见 npm run typecheck）。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'app/src-tauri/**', 'eval-reports/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 前端跑在 Tauri WebView（window/document），核心与工具跑在 Node（process/console）——两端全局都放行
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // 存量代码有少量下划线占位参数（_why）与合理的 any 边界，降为警告不阻塞
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // catch {} 静默容错是本项目的既有惯例（文件不存在则跳过），放行
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
