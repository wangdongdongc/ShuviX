import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/webui'),
  base: '/shuvix/',
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shuvix/chat-protocol': resolve(__dirname, '../../packages/chat-protocol/src'),
      '@shuvix/chat-ui': resolve(__dirname, '../../packages/chat-ui/src/index.ts'),
      '@shuvix/app-shell': resolve(__dirname, '../../packages/app-shell/src'),
      // 子路径别名须在裸包别名之前（Vite 前缀匹配）
      '@shuvix/atomic-editor/code-languages': resolve(
        __dirname,
        '../../packages/atomic-editor/src/code-languages.ts'
      ),
      '@shuvix/atomic-editor/styles.css': resolve(
        __dirname,
        '../../packages/atomic-editor/src/styles/inline-preview.css'
      ),
      '@shuvix/atomic-editor': resolve(__dirname, '../../packages/atomic-editor/src/index.ts')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'out/webui'),
    emptyOutDir: true
  }
})
