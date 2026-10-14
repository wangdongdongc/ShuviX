import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const chatProtocol = resolve(__dirname, '../../packages/chat-protocol/src')
const chatUi = resolve(__dirname, '../../packages/chat-ui/src/index.ts')
const appShell = resolve(__dirname, '../../packages/app-shell/src')

// MV3 Chrome 扩展构建：
//  - 两个入口：每标签页的侧边栏（sidepanel.html）+ 后台 service worker（src/background/sw.ts）
//  - 输出固定文件名（manifest 引用稳定路径，不带 hash）
//  - 复用 @shuvix/* 包源码（别名）。扩展不跑 agent：agent-runtime 只取两个自包含的子路径 ——
//    extractPage 与视图同步的契约 sync/viewContracts（子路径别名，不经包入口 —— 入口会把 pi-* 整个拖进来）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shuvix/agent-runtime/browser/extractPage': resolve(
        __dirname,
        '../../packages/agent-runtime/src/browser/extractPage.ts'
      ),
      // 视图同步的契约（chat-ui 的 syncClient 引它；只引 chord 与 typebox，同样自包含）
      '@shuvix/agent-runtime/sync/viewContracts': resolve(
        __dirname,
        '../../packages/agent-runtime/src/sync/viewContracts.ts'
      ),
      '@shuvix/chat-protocol': chatProtocol,
      '@shuvix/chat-ui': chatUi,
      '@shuvix/app-shell': appShell
    },
    // 跨包共享单一 React 实例（hooks 跨副本会炸）
    dedupe: ['react', 'react-dom']
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/sw.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
})
