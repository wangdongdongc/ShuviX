/**
 * 持久化代码模式（`pi-durable/codemode`）的 QuickJS worker 入口。
 *
 * 由 electron-vite 独立打成 `out/main/codemodeWorker.js`（并列在 electron-builder.yml 的 asarUnpack 里），
 * 供 `services/codemode/sandbox.ts` 的 `CodemodeSandbox` 启动。
 */
import '@earendil-works/pi-codemode/worker'
