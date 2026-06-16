import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const chatProtocol = resolve(__dirname, '../../packages/chat-protocol/src')
const chatUi = resolve(__dirname, '../../packages/chat-ui/src/index.ts')
const atomicEditorSrc = resolve(__dirname, '../../packages/atomic-editor/src')
// 子路径别名须在裸包别名之前——Vite 前缀匹配，否则 '@shuvix/atomic-editor' 会吞掉 '/code-languages'
const atomicEditorAlias = {
  '@shuvix/atomic-editor/code-languages': resolve(atomicEditorSrc, 'code-languages.ts'),
  '@shuvix/atomic-editor/styles.css': resolve(atomicEditorSrc, 'styles/inline-preview.css'),
  '@shuvix/atomic-editor': resolve(atomicEditorSrc, 'index.ts')
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shuvix/chat-protocol': chatProtocol
      }
    },
    build: {
      // pi-ai/pi-agent-core 0.58+ 是纯 ESM（exports 无 require 条件），
      // 必须内联打包，否则 Electron CJS require 会报 ERR_PACKAGE_PATH_NOT_EXPORTED
      externalizeDeps: {
        exclude: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core']
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          pythonWorker: resolve(__dirname, 'src/main/services/pyodide/pythonWorker.ts'),
          sqlWorker: resolve(__dirname, 'src/main/services/pglite/sqlWorker.ts'),
          // CLI 入口：通过 ELECTRON_RUN_AS_NODE=1 在 Electron 内以 node 模式运行；
          // 产物 out/main/cli.js，由 resources/cli/shuvix-cli{,.cmd} shim 触发
          cli: resolve(__dirname, 'src/cli/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shuvix/chat-protocol': chatProtocol
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shuvix/chat-protocol': chatProtocol,
        '@shuvix/chat-ui': chatUi,
        ...atomicEditorAlias
      }
    },
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1'
    }
  }
})
