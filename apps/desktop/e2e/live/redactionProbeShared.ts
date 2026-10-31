/**
 * 自动脱敏两个真模型演练（redactionWork.probe.ts / redactionPolicy.probe.ts，docs/auto-redaction-design.md §11）共用的
 * 那几样：读 env、起隔离实例并种真模型、等一轮跑完（其间回答询问）、读转写。做法照 networkPolicy.probe.ts。
 *
 * 权限询问只放行不碰这台电脑真实主目录的：e2e 只换了 HOME 环境变量，绝对路径照样通向真实的 ~（2026-10-19 的事故）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { until } from '../harness/cdp'
import type { E2EApp } from '../harness/launch'
import type { EventRecorder } from '../harness/seed'
import { syncProbe } from '../harness/sync'
import { collectProbeEnv } from './protocolProbeEnv'

export const ENV_FILE = process.env.SHUVIX_PROBE_ENV_FILE ?? join(homedir(), '.shuvix-probe.env')
/** 跑探针的这台电脑真实的主目录：隔离实例里的 agent 碰到它的一律拒绝 */
export const REAL_HOME = homedir()

export interface ProbeModel {
  key: string
  modelId: string
}

/** key 与模型只从 env（文件）来；只认 deepseek（同 networkPolicy.probe） */
export function probeModel(): ProbeModel {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  const key = env.SHUVIX_PROBE_COMPLETIONS_KEY ?? ''
  const modelId = env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? ''
  const provider = (env.SHUVIX_PROBE_COMPLETIONS_PROVIDER ?? 'deepseek').toLowerCase()
  if (!key) throw new Error(`SHUVIX_PROBE_COMPLETIONS_KEY not found (env or ${ENV_FILE})`)
  if (!modelId) throw new Error(`SHUVIX_PROBE_COMPLETIONS_MODEL not found (env or ${ENV_FILE})`)
  if (provider !== 'deepseek') throw new Error(`only deepseek is wired here, got ${provider}`)
  return { key, modelId }
}

export function makeDebug(dir: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(join(dir, 'debug.log'), `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* 报告目录还没建 */
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    )
  ])
}

export interface SettleOptions {
  app: E2EApp
  events: EventRecorder
  sid: string
  label: string
  /** ask 工具（choice）的回答：第 n 问（从 1 起） */
  answer: (n: number) => string
  debug: (line: string) => void
  /** 安静多久算一轮结束（缺省 10 秒） */
  quietMs?: number
  timeoutMs?: number
}

/**
 * 等会话安静下来（quietMs 没有新事件、且不在忙），其间回答询问；回：问过几次 ask 工具。
 * 权限询问：碰了真实主目录（而不是隔离 HOME）的拒绝，其余放行。
 */
export async function settle(opts: SettleOptions): Promise<number> {
  const { app, events, sid, label, debug } = opts
  const quietMs = opts.quietMs ?? 10_000
  const probe = syncProbe(app.main)
  await probe.install()
  const answered = new Set<string>()
  let questions = 0
  let last = -1
  let quietSince = Date.now()
  await until(
    async () => {
      const view = await withTimeout(probe.viewOf(sid), 8000).catch((error) => {
        debug(`${label}: viewOf failed: ${String(error)}`)
        return undefined
      })
      for (const req of (view?.asks ?? []) as Array<{ id: string; kind: string }>) {
        if (answered.has(req.id)) continue
        let response: Record<string, unknown>
        if (req.kind === 'choice') {
          questions++
          response = { kind: 'other', text: opts.answer(questions) }
        } else {
          const text = JSON.stringify(req)
          const outside =
            text.includes(`${REAL_HOME}/`) && !`${app.home}/`.startsWith(`${REAL_HOME}/`)
          response = outside
            ? {
                kind: 'ask',
                allowed: false,
                reason: `Refused. In this environment the home folder is ${app.home} — use ~ or paths under it.`
              }
            : { kind: 'ask', allowed: true }
        }
        debug(
          `${label}: answering ${req.kind} ${req.id} → ${JSON.stringify(response).slice(0, 120)}`
        )
        await app.main.eval(
          `window.api.agent.respondToInput(${JSON.stringify({ sessionId: sid, requestId: req.id, response })})`
        )
        answered.add(req.id)
        quietSince = Date.now()
      }
      const n = (await events.all()).length
      if (n !== last) {
        last = n
        quietSince = Date.now()
        return false
      }
      return Date.now() - quietSince > quietMs && view !== undefined && view.run?.state !== 'busy'
    },
    'session went quiet',
    opts.timeoutMs ?? 12 * 60 * 1000
  )
  return questions
}

/** 发一条消息（不等这一轮跑完：它可能停在询问上等 settle 去答） */
export async function sendPrompt(app: E2EApp, sid: string, text: string): Promise<void> {
  await app.main.eval(
    `(void window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }), true)`
  )
}

/** 转写：存下来的样子（占位符原样） */
export async function transcriptOf(app: E2EApp, sid: string): Promise<string> {
  return app.main.eval<string>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) {
        if (m.role === 'user') { out.push('>>> USER: ' + m.content); continue }
        if (m.role !== 'assistant') { out.push('### ' + m.role + ': ' + m.content); continue }
        for (const b of m.blocks ?? []) {
          if (b.type === 'text' && b.text?.trim()) out.push('<<< ASSISTANT: ' + b.text)
          if (b.type !== 'tool') continue
          const args = JSON.stringify(b.args ?? {})
          out.push('[TOOL] ' + b.toolName + ' ' + (args.length > 3000 ? args.slice(0, 3000) + '…' : args))
          const result = String(b.result ?? '')
          out.push('[RESULT]' + (b.isError ? ' (ERROR)' : '') + '\\n' + (result.length > 1500 ? result.slice(0, 1500) + '…' : result))
        }
      }
      return out.join('\\n\\n')
    })()
  `)
}

/** 文本里的占位符按会话的对照表换回真值（界面上看到的样子） */
export async function restoredText(app: E2EApp, sid: string, text: string): Promise<string> {
  const placeholders = [...new Set(text.match(/\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g) ?? [])]
  if (placeholders.length === 0) return text
  const table = await app.main.eval<Record<string, { value?: string }>>(
    `window.api.redaction.resolve(${JSON.stringify({ sessionId: sid, placeholders })})`
  )
  return text.replace(/\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}/g, (p) => table[p]?.value ?? p)
}

/**
 * 拒掉 agent 对这台电脑真实主目录的文件读写（这份仓库自己除外）。隔离实例的 HOME 在 /private/tmp 下，真实主目录
 * 因此算「HOME 之外」，文件工具读它不问 —— settle 的拒答管不到；而 dev 构建的提示词里内置技能、手册的路径都在
 * 仓库里（真实主目录下），模型会照着把 `~` 展开成真实主目录（2026-10-31 日记 bot 演练列出过真实的 ~/.shuvix）。
 * 只管文件工具的 path 对象，命令不在内。
 */
export async function installRealHomeGuard(app: E2EApp, repoRoot: string): Promise<void> {
  const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  await installPolicy(
    app,
    'probe-real-home-guard',
    [
      '---',
      'shuvix: policy v1',
      'name: probe-real-home-guard',
      'description: A live probe never reads or writes the real home folder of this computer.',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [path]',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    action: [read, write]',
      `    match: inDir(object.path, ${quote(REAL_HOME)}) && !inDir(object.path, ${quote(repoRoot)})`,
      `    prompt: This environment's home folder is ${app.home}; use ~ or paths under it.`,
      '---',
      ''
    ].join('\n')
  )
}

/** 写下用户策略并等它生效（策略目录按定时器重扫） */
export async function installPolicy(app: E2EApp, name: string, text: string | null): Promise<void> {
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const dir = join(app.home, '.shuvix', 'policies')
  mkdirSync(dir, { recursive: true })
  if (text === null) rmSync(join(dir, `${name}.md`), { force: true })
  else writeFileSync(join(dir, `${name}.md`), text)
  await until(
    async () => {
      const names = await app.main.eval<string[]>(
        `window.api.policy.list().then((ps) => ps.map((p) => p.name))`
      )
      return names.includes(name) === (text !== null)
    },
    `policy ${name} ${text === null ? 'removed' : 'loaded'}`
  )
}
