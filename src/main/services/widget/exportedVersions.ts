/**
 * 导出为独立 Vite 项目时，生成的 package.json 中各依赖的版本。
 *
 * 运行时依赖（react / react-dom / react-router）必须与
 * `resources/bundler/deps/` 中预打包的 ESM bundle 对应的 npm
 * 版本一致，否则导出后的项目行为可能与 ShuviX 内预览不同。
 *
 * Keep in sync with:
 *   - /package.json 的 dependencies / devDependencies（源）
 *   - /scripts/bundle-design-deps.mjs（预打包脚本）
 */
export const EXPORTED_VERSIONS = {
  // 运行时（必须与 shipped bundle 对应）
  react: '^19.2.1',
  'react-dom': '^19.2.1',
  'react-router': '^7.13.1',
  // 工具链（Vite 生态，与 shipped bundle 无关）
  vite: '^6.0.0',
  '@vitejs/plugin-react': '^4.3.0',
  '@tailwindcss/vite': '^4.0.0',
  tailwindcss: '^4.0.0',
  typescript: '~5.6.0',
  '@types/react': '^19.0.0',
  '@types/react-dom': '^19.0.0'
} as const

export type ExportedPackageName = keyof typeof EXPORTED_VERSIONS
