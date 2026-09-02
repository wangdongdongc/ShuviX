/**
 * 真模型探针（live probe）—— 用**真实模型**跑一遍某个能力，然后把转写摊开来读。
 *
 * 与 `e2e/specs/**` 的分工是硬的：
 *   - e2e 用假 provider 脚本化模型，测的是**机制**（发出去了没、落库了没、渲染对不对），
 *     确定性、免费、进 CI；
 *   - 探针用真模型，测的是**工具面好不好用** —— 模型看到我们写的那些文案、状态词、
 *     错误提示之后，会不会走岔。这件事假 provider 天然测不了：脚本里模型永远"懂"。
 *
 * 所以它**不进 `npm run test` / `npm run test:e2e`**（要花钱、要 API key、结果不确定），
 * 单独一条 `npm run probe` 手动跑。
 *
 * 实例仍是隔离的（fake HOME、独立 userData、独立 CDP 端口），**不碰用户正在用的那份数据**；
 * 唯一从真实环境借来的是 provider 与模型：读 `~/Library/Application Support/shuvix/data/shuvix.db`
 * 里的一行，用 `~/.shuvix/.session-state` 解密出 key，直接经 IPC 种进隔离实例。
 * key 只在内存里过一手，不打印、不落盘。
 */
import { execFileSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CdpClient } from '../harness/cdp'
import { until } from '../harness/cdp'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'

const PREFIX = '$SHUVIX_ENC$v1$'

/** 真实实例的两个落点（探针只读它们） */
const realUserData = (): string => join(homedir(), 'Library/Application Support/shuvix')
const realConfigDir = (): string => join(homedir(), '.shuvix')

/**
 * `utils/crypto.decrypt` 的同形实现（`<prefix>ivHex:tagHex:dataHex`，aes-256-gcm，
 * 密钥是 `~/.shuvix/.session-state` 那 32 字节）。
 * 不直接引主进程那份：它连着 electron 的 paths 模块。
 */
function decrypt(value: string): string {
  if (!value?.startsWith(PREFIX)) return value
  const key = readFileSync(join(realConfigDir(), '.session-state'))
  const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(':')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'), {
    authTagLength: 16
  })
  d.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8')
}

export interface RealModel {
  providerId: string
  providerName: string
  apiKey: string
  baseUrl?: string
  apiProtocol?: string
  modelId: string
}

/**
 * 从真实实例里挑一个**已启用**的 provider + 模型。
 * `preferModel` 给个子串（如 'opus'）优先匹配；否则取第一个已启用模型。
 */
export function pickRealModel(preferModel?: string): RealModel {
  const dbPath = join(realUserData(), 'data/shuvix.db')
  if (!existsSync(dbPath)) throw new Error(`找不到真实实例的数据库：${dbPath}`)
  // 用系统 sqlite3 CLI 而不是 better-sqlite3：后者是为 Electron 编译的（electron-rebuild），
  // 在普通 node 里加载会报 NODE_MODULE_VERSION 不符。只读一行配置，不值得为它另装依赖。
  const sql =
    `SELECT p.id AS providerId, p.name AS providerName, p.apiKey, p.baseUrl, p.apiProtocol, ` +
    `m.modelId FROM provider_models m JOIN providers p ON p.id = m.providerId ` +
    `WHERE m.isEnabled = 1 AND p.isEnabled = 1 AND p.apiKey <> ''`
  const raw = execFileSync('sqlite3', ['-json', 'shuvix.db', sql], {
    cwd: dirname(dbPath),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  }).trim()
  const rows = (raw ? JSON.parse(raw) : []) as Array<Record<string, string>>
  if (rows.length === 0) throw new Error('真实实例里没有已启用且带 key 的 provider/模型')
  const hit =
    (preferModel ? rows.find((r) => r.modelId.includes(preferModel)) : undefined) ??
    rows.find((r) => /opus|sonnet|gpt|claude|kimi/i.test(r.modelId)) ??
    rows[0]
  return {
    providerId: hit.providerId,
    providerName: hit.providerName,
    apiKey: decrypt(hit.apiKey),
    baseUrl: hit.baseUrl || undefined,
    apiProtocol: hit.apiProtocol || undefined,
    modelId: hit.modelId
  }
}

/**
 * 把真实 provider 种进隔离实例并设为默认（key 只经 IPC 传，不打印、不落盘）。
 *
 * **同 id 的内置 provider 优先走 updateConfig 而不是 add**：内置 provider 的 id
 * （`kimi-coding` / `openai` / …）本身就是 pi-ai 侧的识别依据，`add` 出来的自定义
 * provider 会拿到一个 uuid，请求路径与鉴权都可能不同 —— 实测就是一个 404。
 */
export async function seedRealModel(main: CdpClient, model: RealModel): Promise<void> {
  const cfg = JSON.stringify({
    id: model.providerId,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl ?? '',
    apiProtocol: model.apiProtocol ?? 'openai-completions'
  })
  const name = JSON.stringify(`probe-${model.providerName}`)
  const modelId = JSON.stringify(model.modelId)
  await main.eval(
    `(async () => {
      const cfg = ${cfg}
      const existing = (await window.api.provider.listAll()).find((p) => p.id === cfg.id)
      let providerId = cfg.id
      if (existing) {
        await window.api.provider.updateConfig(cfg)
        await window.api.provider.toggleEnabled({ id: cfg.id, isEnabled: true })
      } else {
        const p = await window.api.provider.add({
          name: ${name},
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          apiProtocol: cfg.apiProtocol
        })
        providerId = p.id
      }
      let row = (await window.api.provider.listModels(providerId)).find((m) => m.modelId === ${modelId})
      if (!row) {
        await window.api.provider.addModel({ providerId, modelId: ${modelId} })
        row = (await window.api.provider.listModels(providerId)).find((m) => m.modelId === ${modelId})
      }
      if (row) {
        await window.api.provider.toggleModelEnabled({ id: row.id, isEnabled: true })
        await window.api.provider.updateModelCapabilities({
          id: row.id,
          capabilities: { maxInputTokens: 200000, maxOutputTokens: 8192, vision: true }
        })
      }
      for (const [key, value] of [
        ['general.defaultProvider', providerId],
        ['general.defaultModel', ${modelId}]
      ]) {
        await window.api.settings.set({ key, value })
      }
      return true
    })()`
  )
}

export interface Probe {
  app: E2EApp
  events: EventRecorder
  /**
   * 自动放行安全询问（扮演那个会点「允许一次」的用户）。
   *
   * 隔离实例里内置的 `ask-on-command` 对每条命令都问，而探针没人看着 —— 不放行的话
   * 任何跑 bash 的子会话都会停在 `waiting-input`，探到的全是"卡住"而不是工具面本身。
   * 想**故意**探那条卡住的路径就别开它（或者只放行一部分）。
   */
  autoAllow(opts?: { only?: (command: string) => boolean }): Promise<void>
  /** 发一条用户消息并等到**整个会话安静下来**（含自动续跑起的后续轮） */
  ask(sessionId: string, text: string, opts?: { quietMs?: number }): Promise<void>
  /** 会话 id（探针建的那条根会话） */
  rootSessionId: string
  /** 把根会话与它全部子会话的转写摊平写进一个文件，返回路径 */
  dump(outPath: string): Promise<string>
  stop(): Promise<void>
}

/** 起一个带真实模型的隔离实例，并建好项目 + 一条根会话 */
export async function startProbe(opts: {
  workdir: string
  preferModel?: string
  title?: string
}): Promise<Probe> {
  const model = pickRealModel(opts.preferModel)
  const app = await launchApp()
  await waitRendererReady(app.main)
  await seedRealModel(app.main, model)

  mkdirSync(opts.workdir, { recursive: true })
  const project = await createProject(app.main, { name: 'ProbeProj', path: opts.workdir })
  const rootSessionId = await app.main.eval<string>(
    `window.api.session
      .create(${JSON.stringify({ title: opts.title ?? 'probe', projectId: project.id })})
      .then((s) => s.id)`
  )
  const events = eventRecorder(app.main)
  await events.install()

  const autoAllow = async (o?: { only?: (command: string) => boolean }): Promise<void> => {
    // 装在渲染端：input_request 事件一到就回一条 allowed（与用户点「允许一次」同一条 IPC）
    const filter = o?.only ? `(${o.only.toString()})` : '(() => true)'
    await app.main.eval(
      `(() => {
        if (window.__probeAutoAllow) return true
        window.__probeAutoAllow = []
        window.api.agent.onEvent((ev) => {
          if (ev.type !== 'input_request') return
          const req = ev.request
          const command = req.command ?? req.question ?? ''
          if (!${filter}(command)) return
          window.__probeAutoAllow.push(command)
          window.api.agent.respondToInput({
            sessionId: ev.sessionId,
            requestId: req.id,
            response: { kind: req.kind, allowed: true, selections: [] }
          })
        })
        return true
      })()`
    )
  }

  const ask = async (sessionId: string, text: string, o?: { quietMs?: number }): Promise<void> => {
    const quietMs = o?.quietMs ?? 8000
    // 先等这一轮真正落定 —— 只看「事件安静」会在一个还在飞的工具调用中途就收工
    await app.main.eval(
      `window.api.agent.prompt({ sessionId: ${JSON.stringify(sessionId)}, text: ${JSON.stringify(text)} })`
    )
    // 「安静」而不是「一次 agent_end」：自动续跑会再起轮，中途的 end 不代表结束
    let lastCount = -1
    let quietSince = Date.now()
    await until(
      async () => {
        const n = (await events.all()).length
        if (n !== lastCount) {
          lastCount = n
          quietSince = Date.now()
          return false
        }
        return Date.now() - quietSince > quietMs
      },
      'session went quiet',
      15 * 60 * 1000
    )
  }

  const dump = async (outPath: string): Promise<string> => {
    const text = await app.main.eval<string>(`
      (async () => {
        const sessions = await window.api.session.list()
        const root = sessions.find((s) => s.id === ${JSON.stringify(rootSessionId)})
        const kids = sessions.filter((s) => s.parentId === ${JSON.stringify(rootSessionId)})
        const out = []
        for (const s of [root, ...kids]) {
          if (!s) continue
          out.push('\\n' + '='.repeat(78))
          out.push((s.parentId ? 'SUB-SESSION' : 'SESSION') + '  ' + s.title + '  ' + s.id)
          out.push('='.repeat(78))
          const msgs = await window.api.message.list(s.id)
          for (const m of msgs) {
            if (m.role === 'user') {
              out.push('\\n>>> USER' + (m.metadata?.isSystemNotice ? ' (SYSTEM NOTICE)' : '') + ':')
              out.push(m.content)
              continue
            }
            if (m.role !== 'assistant') { out.push('\\n### ' + m.role + ': ' + m.content); continue }
            if (m.content?.trim()) out.push('\\n<<< ASSISTANT:\\n' + m.content)
            for (const b of m.blocks ?? []) {
              if (b.type !== 'tool') continue
              out.push('\\n  [TOOL] ' + b.toolName + ' ' + JSON.stringify(b.args ?? {}))
              out.push('  [RESULT]' + (b.isError ? ' (ERROR)' : '') + '\\n' +
                String(b.result ?? '').split('\\n').map((l) => '    ' + l).join('\\n'))
            }
          }
        }
        return out.join('\\n')
      })()
    `)
    writeFileSync(outPath, text)
    return outPath
  }

  return { app, events, autoAllow, ask, rootSessionId, dump, stop: () => app.stop() }
}
