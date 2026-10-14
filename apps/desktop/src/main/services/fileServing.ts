/**
 * 把本机文件交给页面的那几样共用的读法 —— 桌面的自定义协议（`customProtocols.ts`：`shuvix-preview://` /
 * `shuvix-lib://`）与网络服务的 HTTP 路由（`frontend/network/fileRoutes.ts`：`/files/*`、`/lib/*`，
 * server mode phase D）用的是同一份（纯的 MIME 表与 Range 解析在 `utils/fileResponse.ts`）：
 *
 *  - `resolvePreviewFilePath`：预览资源的路径解析（相对路径按会话的工作目录，与 files.read 同口径）；
 *  - `readSandboxLib`：交互图沙箱的库 —— 只按名字查白名单，命中回随包文件（进程内缓存，读失败不缓存）。
 *
 * 不碰 Electron：两种外壳（protocol.handle 的 Response、node:http 的 ServerResponse）各自拼应答。
 * 用户裁决：**不限路径**（与改造前的协议一样，给什么路径读什么）。
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { SANDBOX_LIBS } from '@shuvix/chat-protocol/utils/interactiveFence'
import { resolveProjectConfig } from './toolContext'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { getSandboxLibsDir } from '../utils/paths'

/** 预览资源的路径：相对路径按会话的工作目录解析（会话不在 → 按空工作目录，绝对路径照样能读） */
export function resolvePreviewFilePath(sessionId: string, rawPath: string): string {
  const config = resolveProjectConfig(sessionId)
  return resolveReadPath(rawPath, config.workingDirectory)
}

/** 读过的库文件（两份、各两三百 KB，随包只读 —— 进程内缓存一次就够） */
const sandboxLibCache = new Map<string, Buffer>()

/** 这个名字是不是沙箱库白名单里的库（`Object.hasOwn`：原型链上的名字不算） */
export function isSandboxLibName(name: string): boolean {
  return Object.hasOwn(SANDBOX_LIBS, name)
}

/**
 * 按名字取沙箱库的字节：不在白名单 → undefined（不碰磁盘）；读失败 → 抛（不缓存失败，下次再读）
 */
export async function readSandboxLib(name: string): Promise<Buffer | undefined> {
  const lib = isSandboxLibName(name) ? SANDBOX_LIBS[name] : undefined
  if (!lib) return undefined
  let body = sandboxLibCache.get(lib.file)
  if (!body) {
    body = await readFile(join(getSandboxLibsDir(), lib.file))
    sandboxLibCache.set(lib.file, body)
  }
  return body
}
