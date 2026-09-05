/**
 * Workflow 自动触发端到端（隔离实例）：内置 auto-title 的埋点链路 + 用户工作流全链。
 *
 * 观测面 = fake HOME 下 `~/.shuvix/workflows/.runs/<name>/wfr-*.jsonl` journal ——
 * 引擎在 fire 的同步段落 meta、run 收尾落 end，`until` 轮询文件即可，无需任何 UI。
 * 隔离实例没有 API key 也没有默认模型：`session.prompt-accepted` 在 LLM 调用之前触发
 * （埋点照发），auto-title 的派发因「无模型」失败 —— end ok:false 正是这条链路
 * 走通到派发门口的证据；用户工作流（不派发 agent 的脚本）则完整跑到 ok:true。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { until } from '../../harness/cdp'

let app: E2EApp
let wfDir: string

type RunRecord = Record<string, unknown> & { type: string; event?: Record<string, unknown> }

const runsDir = (name: string): string => join(wfDir, '.runs', name)
const runFiles = (name: string): string[] =>
  existsSync(runsDir(name))
    ? readdirSync(runsDir(name))
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
    : []
const readRun = (name: string, file: string): RunRecord[] =>
  readFileSync(join(runsDir(name), file), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RunRecord)

/**
 * 等到某工作流出现「meta.sessionId === sid 且已带 end」的 run journal，返回其全部记录。
 * 按会话选取而非按文件序号：run 文件名是 uuid（排序 ≠ 到达序），且上一用例的
 * turn-completed run 可能在本用例开始后才落 end —— 序号选取会拿错 run。
 */
const untilRunForSession = (name: string, sid: string): Promise<RunRecord[]> =>
  until(() => {
    for (const file of runFiles(name)) {
      const records = readRun(name, file)
      const meta = records.find((r) => r.type === 'meta')
      if (meta?.sessionId === sid && records.some((r) => r.type === 'end')) return records
    }
    return undefined
  }, `${name} run journal for session ${sid} with end record`)

const createSession = (): Promise<string> =>
  app.main.eval<string>(`window.api.session.create({}).then((s) => s.id)`)

/** 发送 prompt 并容忍 LLM 失败（无 API key/无模型）；埋点在派发前后照常触发 */
const promptTolerant = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined)`
  )

beforeAll(async () => {
  app = await launchApp()
  wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })

  // echo：绑定 turn-completed、无 when、不派发 agent —— 每轮必跑，充当同步栅栏
  writeFileSync(
    join(wfDir, 'echo.md'),
    [
      '---',
      'shuvix: workflow v1',
      'name: echo',
      'shuvix-workflow-on:',
      '  - trigger: session.turn-completed',
      '---',
      '',
      'E2E echo workflow.',
      '',
      '```js workflow',
      'return event.turnCount',
      '```',
      ''
    ].join('\n')
  )
  // 结构非法（裸 on）：即便 autorunEnabled 也必须被扫描整份拒绝
  writeFileSync(
    join(wfDir, 'bad-flow.md'),
    [
      '---',
      'shuvix: workflow v1',
      'name: bad-flow',
      'on:',
      '  - trigger: session.prompt-accepted',
      '---',
      '',
      '```js workflow',
      'return 1',
      '```',
      ''
    ].join('\n')
  )
  // 纯用户工作流默认关 —— 显式启用（bad-flow 一并启用，证明拦它的是非法而非默认关）
  writeFileSync(
    join(wfDir, '.config.json'),
    JSON.stringify({ autorunEnabled: { echo: true, 'bad-flow': true } })
  )
})
afterAll(async () => {
  await app.stop()
})

describe('内置 auto-title —— session.prompt-accepted 埋点链路', () => {
  it('首条 prompt（默认标题会话）→ quick run journal：meta 事实齐全、end 因无模型失败', async () => {
    const sid = await createSession()
    await promptTolerant(sid, 'hello')

    const records = await untilRunForSession('auto-title', sid)
    const meta = records.find((r) => r.type === 'meta')!
    // 调用路径进 meta（M2′）：run 的身份是 runId，「被什么唤起」是它的一个属性
    expect(meta.invocation).toEqual({ kind: 'trigger', trigger: 'session.prompt-accepted' })
    expect(meta.source).toBe('builtin')
    expect(meta.sessionId).toBe(sid)
    // 会话域埋点缺省按会话分道 —— 两个会话同时轮结束不再互相 skip
    expect(meta.lane).toBe(`auto-title\u0000${sid}`)
    expect(meta.event!.promptText).toBe('hello')
    expect(meta.event!.isDefaultTitle).toBe(true)
    // 埋点如实报会话档案：`session.create({})` 无项目 ⇒ 「默认聊天智能体」的基座 chat
    expect(meta.event!.profileName).toBe('chat')

    // 隔离实例无默认模型：派发在 resolveRunModel 处止步，run 以人读原因收尾
    const end = records.find((r) => r.type === 'end')!
    expect(end.ok).toBe(false)
    expect(String(end.error)).toContain('no model')
  })
})

describe('用户工作流 —— session.turn-completed 全链', () => {
  it('echo（启用后）随轮结束真跑：payload 事实齐全、脚本返回值落 end', async () => {
    const sid = await createSession()
    await promptTolerant(sid, 'second message')

    const records = await untilRunForSession('echo', sid)
    const meta = records.find((r) => r.type === 'meta')!
    expect(meta.invocation).toEqual({ kind: 'trigger', trigger: 'session.turn-completed' })
    expect(meta.sessionId).toBe(sid)
    expect(meta.lane).toBe(`echo\u0000${sid}`)
    const event = meta.event as { turnCount: number; textMessageCount: number; recentText: string }
    expect(event.turnCount).toBeGreaterThanOrEqual(1)
    expect(event.textMessageCount).toBeGreaterThanOrEqual(1)
    expect(event.recentText.startsWith('User:')).toBe(true)

    const end = records.find((r) => r.type === 'end')!
    expect(end.ok).toBe(true)
    expect(end.output).toBe(event.turnCount)
  })
})

describe('用户改名后 —— 自动标题不再插手', () => {
  it('session:updateTitle 改名再 prompt → auto-title 零新增 run（echo journal 作同步栅栏）', async () => {
    const sid = await createSession()
    await app.main.eval(
      `window.api.session.updateTitle({ id: ${JSON.stringify(sid)}, title: 'Renamed by user' })`
    )

    const autoTitleBefore = runFiles('auto-title').length
    await promptTolerant(sid, 'third message')

    // 栅栏：本会话这一轮的 turn-completed 已被 echo 消费完毕
    await untilRunForSession('echo', sid)
    // quick：标题非默认 → prompt-accepted 不命中；refine：titleOrigin='user' → 也不命中
    expect(runFiles('auto-title').length).toBe(autoTitleBefore)
  })
})

describe('非法用户工作流 —— 整份拒绝而不伤服务', () => {
  it('裸 on 的 bad-flow 落盘且显式启用 → app 照常服务、无该名 journal', async () => {
    // 前面的用例已多次 fire（bad-flow 若被误认合法早就该有 journal 了）
    const sid = await createSession()
    expect(typeof sid).toBe('string')
    expect(sid.length).toBeGreaterThan(0)
    expect(existsSync(runsDir('bad-flow'))).toBe(false)
  })
})
