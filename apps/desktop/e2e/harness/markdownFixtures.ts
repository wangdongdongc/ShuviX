/**
 * 从系统打开 md 这一区（`e2e/specs/markdown/`）的共用夹具。
 *
 * 两件事：
 *   - **用户自己的目录**：md 文件所在的目录就是会话的工作目录，它不该在 fake HOME 里（HOME 是
 *     「应用的地盘」，而这里要证的恰恰是「应用不动用户的目录」），所以另起一个临时目录，取 realpath
 *     （macOS 的 /tmp、/var 都是链接，主进程按真实路径开窗，断言也得按真实路径比）；
 *   - **先种模型再带着 md 启动**：md 窗口的渲染端只在启动时读一次提供商 / 模型（没选中模型时输入卡片
 *     发不出去），而带着 md 启动时没有主窗口可以先去种 —— 所以先普通启动一次、种好假提供商、
 *     `stop({ keepHome: true })`，再用同一个 HOME 带着 md 参数起第二次。
 *
 * 协作编辑（`markdown-coedit`）另外用到两件：`captureEvents`（在 md 窗口里把本会话的 ChatEvent 记进
 * 页面全局 —— 流式参数的 toolCallId、工具的起止、run 的结束都从这里读）与 `readOnlyDir`（让自动保存
 * 失败：保存是「同目录临时文件 + rename」，所以要锁的是**目录**而不是文件 —— 只读文件照样被 rename 盖掉）。
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { launchApp, type E2EMarkdownApp, type MarkdownLaunchOptions } from './launch'
import { seedFakeProvider } from './seed'
import { startFakeProvider, type FakeProvider } from './fakeProvider'
import { until, type CdpClient } from './cdp'

/** 假提供商的模型 id（与 seedFakeProvider 一起写进默认模型） */
export const MD_FAKE_MODEL = 'e2e-md-model'

export interface UserDir {
  /** 目录的真实路径 */
  root: string
  /** 在目录里写一份文件（中间目录自动建），回它的绝对路径 */
  file(rel: string, content: string): string
  /** 建一个符号链接 `rel` → `target`（target 为绝对路径），回链接的绝对路径 */
  link(rel: string, target: string): string
  /** 建一个目录，回它的绝对路径 */
  dir(rel: string): string
  /** 删掉整个目录（afterAll） */
  remove(): void
}

/** 一个「用户自己的」临时目录（不在 fake HOME 里） */
export function userDir(prefix = 'shuvix-md-user-'): UserDir {
  const root = realpathSync(mkdtempSync(join('/private/tmp', prefix)))
  return {
    root,
    file(rel, content) {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return path
    },
    link(rel, target) {
      const path = join(root, rel)
      mkdirSync(dirname(path), { recursive: true })
      symlinkSync(target, path)
      return path
    },
    dir(rel) {
      const path = join(root, rel)
      mkdirSync(path, { recursive: true })
      return path
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/**
 * 起一个假提供商、把它种成默认模型，再带着 md 参数（不等主窗口）启动。
 * 返回的实例用完照常 `stop()`；假提供商由调用方 `close()`。
 */
export async function launchMarkdownWithProvider(
  opts: Omit<MarkdownLaunchOptions, 'expectMainWindow' | 'home'> & {
    /**
     * 界面语言（`general.language`，种模型时一并写下）。md 窗口的文案（协作编辑的提示条、虚影标签）
     * 要按字面断言时给它 —— 缺省跟随系统语言，随跑测试的机器变。
     */
    language?: string
  }
): Promise<{ app: E2EMarkdownApp; provider: FakeProvider }> {
  const { language, ...launchOpts } = opts
  const provider = await startFakeProvider()
  const seeding = await launchApp()
  try {
    await seedFakeProvider(seeding.main, { baseUrl: provider.baseUrl, modelId: MD_FAKE_MODEL })
    if (language) {
      await seeding.main.eval(
        `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(language)} })`
      )
    }
  } catch (err) {
    await seeding.stop()
    await provider.close()
    throw err
  }
  await seeding.stop({ keepHome: true })
  try {
    const app = await launchApp({ ...launchOpts, home: seeding.home, expectMainWindow: false })
    return { app, provider }
  } catch (err) {
    rmSync(seeding.home, { recursive: true, force: true })
    await provider.close()
    throw err
  }
}

/** 主进程日志里某个标记出现的行（按写入顺序） */
export function logLines(log: string, marker: string): string[] {
  return log.split('\n').filter((l) => l.includes(marker))
}

/**
 * 把一个目录设成只读（0555），回一个复原函数（幂等，afterAll 里再调一次兜底）。
 *
 * 用来让 md 窗口的自动保存**失败**：保存是「同目录临时文件 + rename」，只读的是文件时 rename 照样
 * 把它盖掉，只有目录只读才建不出临时文件。目录里的文件照常可读。
 */
export function readOnlyDir(dir: string): () => void {
  const mode = statSync(dir).mode & 0o777
  chmodSync(dir, 0o555)
  let restored = false
  return () => {
    if (restored) return
    restored = true
    chmodSync(dir, mode)
  }
}

/** captureEvents 记下的一条 ChatEvent（只留断言要看的字段） */
export interface CapturedEvent {
  /** 页面里收到它的时刻（Date.now()） */
  at: number
  type: string
  toolCallId?: string
  toolName?: string
  argsDelta?: string
  isError?: boolean
  result?: string
  reason?: string
  /** input_request 的请求 id / 种类 */
  requestId?: string
  requestKind?: string
  /** toolcall_generating 上有没有 toolCallId 这个键（区分「没给」与「给了空串」） */
  hasToolCallId: boolean
}

export interface EventLog {
  /** 到目前为止记下的全部事件（按到达顺序） */
  all(): Promise<CapturedEvent[]>
  /** 清空记录（不退订） */
  clear(): Promise<void>
  /** 等一条满足 pred 的事件；回它 */
  waitFor(
    pred: (e: CapturedEvent) => boolean,
    what: string,
    timeoutMs?: number
  ): Promise<CapturedEvent>
  /** 某次工具调用的 tool_end（等它到） */
  toolEnd(toolCallId: string, timeoutMs?: number): Promise<CapturedEvent>
  /** 第 n 次（1 起）agent_end —— 一轮 run 结束（等它到） */
  runEnd(n?: number, timeoutMs?: number): Promise<CapturedEvent>
}

/**
 * 在 md 窗口里订阅 `window.api.agent.onEvent`，把 `sid` 的事件记进页面全局 `__e2eCoEvents`。
 * 重复调用会先退订上一次的（一个窗口只挂一个记录器）。
 */
export async function captureEvents(client: CdpClient, sid: string): Promise<EventLog> {
  await client.eval(`(() => {
    window.__e2eCoEventsOff?.()
    window.__e2eCoEvents = []
    window.__e2eCoEventsOff = window.api.agent.onEvent((e) => {
      if (e.sessionId !== ${JSON.stringify(sid)}) return
      window.__e2eCoEvents.push({
        at: Date.now(),
        type: e.type,
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        argsDelta: e.argsDelta,
        isError: e.isError,
        result: typeof e.result === 'string' ? e.result : undefined,
        reason: e.reason,
        requestId: e.request?.id,
        requestKind: e.request?.kind,
        hasToolCallId: 'toolCallId' in e
      })
    })
    return true
  })()`)
  const all = (): Promise<CapturedEvent[]> =>
    client.eval<CapturedEvent[]>(`window.__e2eCoEvents ?? []`)
  const waitFor = async (
    pred: (e: CapturedEvent) => boolean,
    what: string,
    timeoutMs?: number
  ): Promise<CapturedEvent> => until(async () => (await all()).find(pred), what, timeoutMs)
  return {
    all,
    clear: async () => {
      await client.eval(`(window.__e2eCoEvents = [], true)`)
    },
    waitFor,
    toolEnd: (toolCallId, timeoutMs) =>
      waitFor(
        (e) => e.type === 'tool_end' && e.toolCallId === toolCallId,
        `tool_end ${toolCallId}`,
        timeoutMs
      ),
    runEnd: async (n = 1, timeoutMs) => {
      const ends = await until(
        async () => {
          const got = (await all()).filter((e) => e.type === 'agent_end')
          return got.length >= n ? got : null
        },
        `agent_end #${n}`,
        timeoutMs
      )
      return ends[n - 1]
    }
  }
}
