import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // pi-ai/pi-agent-core 0.58+ 是纯 ESM（exports 无 require 条件），
      // 必须内联打包，否则 Electron CJS require 会报 ERR_PACKAGE_PATH_NOT_EXPORTED
      externalizeDeps: {
        exclude: ['@mariozechner/pi-ai', '@mariozechner/pi-agent-core']
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          pythonWorker: resolve(__dirname, 'src/plugins/pyodide/pythonWorker.ts'),
          sqlWorker: resolve(__dirname, 'src/main/tools/utils/sqlWorker.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1'
    }
  }
})
