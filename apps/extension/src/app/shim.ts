/**
 * 浏览器环境兜底 shim —— 必须在任何 pi-ai / pi-agent-core 模块求值之前执行。
 * 作为 main.tsx 的第一个 import，确保在后续 import 链（含 pi-*）之前运行。
 *
 * pi-ai 内部有 `typeof process !== 'undefined' && process.env.X` 守卫；提供一个最小
 * process.env 让这些访问安全返回 undefined（绝不触发其读环境变量密钥的 node:fs 路径）。
 */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
if (!g.process) {
  g.process = { env: {} }
}
