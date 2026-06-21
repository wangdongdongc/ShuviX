import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const chatProtocol = resolve(__dirname, '../../packages/chat-protocol/src')
const chatUi = resolve(__dirname, '../../packages/chat-ui/src/index.ts')
const agentRuntime = resolve(__dirname, '../../packages/agent-runtime/src/index.ts')
const appShell = resolve(__dirname, '../../packages/app-shell/src')

// MV3 Chrome 扩展构建：
//  - 两个入口：整页 App（app.html）+ 后台 Service Worker（src/background/sw.ts）
//  - 输出固定文件名（manifest 引用稳定路径，不带 hash）
//  - 复用 @shuvix/* 包源码（别名）；pi-ai/pi-agent-core 纯 ESM 由 Vite 正常 bundle
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shuvix/chat-protocol': chatProtocol,
      '@shuvix/chat-ui': chatUi,
      '@shuvix/agent-runtime': agentRuntime,
      '@shuvix/app-shell': appShell
    },
    // 跨包共享单一 React 实例（hooks 跨副本会炸）
    dedupe: ['react', 'react-dom']
  },
  define: {
    // pi-ai 内部少量 `typeof process !== 'undefined' && process.env.X` 守卫的兜底
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'app.html'),
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
