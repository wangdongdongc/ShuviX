/**
 * `shuvix` CLI 认会话 —— 会话里的命令调 CLI 时，主进程据此知道它来自**哪条**会话（授予 widget 目录、
 * 停本会话的后台任务、把截图写进本会话的工具结果……）。
 *
 * 从前 CLI 只报环境变量 `SHUVIX_SESSION_ID`，主进程照单全收：沙箱里的命令把它改成别的会话 id，就能给
 * 那条会话加授权、停它的后台任务。现在命令的环境里另有一个 `SHUVIX_SESSION_KEY` = 本进程随机密钥对
 * 会话 id 的 HMAC，CLI 两样一起带上，主进程核对不上就当这次调用不属于任何会话。密钥只在主进程内存里
 * （不落盘、每次启动换一个），命令拿到的只有自己那条会话的 key，算不出别的会话的。
 *
 * 不防的：没被圈进沙箱的命令本来就以用户的全部权限运行（能读同一用户其他进程的环境、能直接改数据库），
 * 那一侧靠 ask-on-command 与自动审查，不靠这里。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/** 命令环境里放会话 key 的变量名（会话 id 仍是 SHUVIX_SESSION_ID） */
export const CLI_SESSION_KEY_ENV = 'SHUVIX_SESSION_KEY'

/**
 * 本进程的密钥。`SHUVIX_E2E_CLI_SESSION_SECRET` 只给 e2e 的隔离实例用：harness 直接跑 CLI（没有会话里的
 * 命令替它注入 key），得按同一个密钥自己算出 key 才能扮成「会话里的命令」。产品从不设它 —— 它出自启动
 * ShuviX 的那个环境，沙箱里的命令改不到正在运行的进程的环境
 */
const secret = process.env.SHUVIX_E2E_CLI_SESSION_SECRET
  ? Buffer.from(process.env.SHUVIX_E2E_CLI_SESSION_SECRET)
  : randomBytes(32)

/** 一条会话的 CLI key（注入那条会话的命令环境） */
export function cliSessionKey(sessionId: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('hex')
}

/** CLI 报来的会话 id 与 key 对得上就回会话 id，否则 undefined（当这次调用不属于任何会话） */
export function verifiedCliSession(sessionId: unknown, key: unknown): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '' || typeof key !== 'string') return undefined
  const expected = Buffer.from(cliSessionKey(sessionId))
  const given = Buffer.from(key)
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? sessionId
    : undefined
}
