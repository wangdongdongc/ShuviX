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
      '@shuvix/chat-ui': resolve(__dirname, '../../packages/chat-ui/src/index.ts')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, 'out/webui'),
    emptyOutDir: true
  }
})
