/**
 * Emscripten 虚拟文件系统路径工具
 * 用于 WASM Worker（Pyodide / PGLite）中将宿主路径映射为 Emscripten POSIX 挂载点
 */

import { platform } from 'process'

/**
 * 将宿主机路径转换为 Emscripten POSIX 虚拟文件系统挂载点路径
 *
 * - POSIX（macOS / Linux）：路径本身即为合法挂载点，原样返回
 * - Windows：`C:\Users\foo` → `/C/Users/foo`
 *
 * 注意：NODEFS 的 `root` 参数仍需使用原始宿主路径，
 *       此函数仅用于 Emscripten FS 的 mkdir / mount / chdir 等操作。
 */
export function toEmscriptenPath(hostPath: string): string {
  if (platform !== 'win32') return hostPath
  // C:\Users\foo → /C/Users/foo
  return '/' + hostPath.replace(/\\/g, '/').replace(':', '')
}
