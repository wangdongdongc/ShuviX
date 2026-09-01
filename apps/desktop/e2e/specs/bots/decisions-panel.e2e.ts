/**
 * A4 · 「Bot 决策」子视图 —— 会话面板的新工具页（设计 §9「这个 bot 为什么没说话」的
 * 用户侧出口）。数据源 bot:decisions（readBotDecisions 跨 bot 目录过滤合并，ts 升序）。
 *
 * 被测面：
 *   - 工具入口只对聊天会话出现（SessionToolbar showBotDecisions ⟵ settings.bots 非空）；
 *   - 渲染形态：按 messageSeq 分组、组间 seq 降序、无 seq 记录归入 '·' 组置底；
 *     kind 是开放集 —— 等宽**原文**呈现，未知值照渲不翻译；
 *   - 活链：在飞活动收摊（ended 删键）即自动刷新，不需要手动点刷新按钮。
 *
 * SessionPanel 对 botDecisions 的回落分支（面板停在该工具但宿主没注入内容 → 回落
 * Files）在真实 UI 里**不可达**：工具胶囊与内容注入由同一个 isBotSession 驱动，
 * 永远同进同退 —— 刻意不测（risk-12：伪造一半注入才敲得开，那不是产品路径）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { until } from '../../harness/cdp'
import { createBotSession, waitRendererReady, writeBotMd } from '../../harness/seed'
import {
  botSessionPane,
  chatPane,
  sidebarPane,
  type BotSessionPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let sidebar: SidebarPane
let chat: ChatPane
let pane: BotSessionPane

const PROBE = 'a4-dec-probe'

const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: A4 decisions e2e probe — claim then say, zero LLM.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'A4 决策面板探针：claim → say。',
  '',
  '```js workflow',
  "var verdict = await claim({ decision: 'reply', relevance: 5 })",
  'if (!verdict.won) return { outcome: verdict.reason }',
  "await say('探针的回答')",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

/** 直写某个 bot 目录的 decisions.jsonl（34 号：面板只认文件事实，不问记录怎么来的） */
function seedDecisions(dirName: string, records: Array<Record<string, unknown>>): void {
  const dir = join(app.botsDir, '.runs', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'decisions.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
  )
}

/** IPC 回读（与面板同一数据源） */
const readDecisions = (sid: string): Promise<Array<{ kind: string; messageSeq?: number }>> =>
  app.main.eval(`window.api.bot.decisions({ sessionId: ${JSON.stringify(sid)} })`)

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

async function open(title: string): Promise<void> {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  sidebar = sidebarPane(app.main)
  chat = chatPane(app.main)
  pane = botSessionPane(app.main)

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)
  writeBotMd(app, 'd-probe', {
    description: 'decisions probe bot',
    displayName: 'DProbe',
    pipeline: PROBE
  })
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('工具入口（A4-33）', () => {
  it('聊天会话的工具栏有 botDecisions 胶囊；普通会话没有（Files 仍在，证明栏本身渲染了）', async () => {
    await createBotSession(app.main, { bots: ['d-probe'], title: 'A4-D33' })
    await app.main.eval(`window.api.session.create({ title: 'A4-D-plain' })`)
    await until(async () => (await sidebar.titles()).includes('A4-D-plain'), 'sessions listed')

    await open('A4-D33')
    await until(async () => (await pane.toolbarTools()).includes('botDecisions'), 'capsule on')
    expect(await pane.toolbarTools()).toContain('files')

    await open('A4-D-plain')
    await until(async () => (await pane.toolbarTools()).includes('files'), 'toolbar rendered')
    expect(await pane.toolbarTools()).not.toContain('botDecisions')
  })
})

describe('渲染形态（A4-34）', () => {
  it('两目录直种：组按 seq 降序、无 seq 组置底组头 "·"、kind 等宽原文（未知值照渲）', async () => {
    const sid = await createBotSession(app.main, { bots: ['d-probe'], title: 'A4-D34' })
    // 跨两个 bot 目录混写：seq 3 的两条分住两目录（ts 交错），一条无 seq，一个未知 kind
    seedDecisions('d-one', [
      {
        ts: 1000,
        kind: 'claim_won',
        sessionId: sid,
        botName: 'd-one',
        ticketId: 't1',
        messageSeq: 3
      },
      {
        ts: 3000,
        kind: 'zz_custom_kind',
        sessionId: sid,
        botName: 'd-one',
        ticketId: 't2',
        messageSeq: 5
      }
    ])
    seedDecisions('d-two', [
      {
        ts: 2000,
        kind: 'run_end',
        sessionId: sid,
        botName: 'd-two',
        ticketId: 't3',
        messageSeq: 3
      },
      { ts: 4000, kind: 'mailbox_timeout', sessionId: sid, botName: 'd-two', ticketId: 't4' }
    ])

    await until(async () => (await sidebar.titles()).includes('A4-D34'), 'row listed')
    await open('A4-D34')
    await until(async () => (await pane.toolbarTools()).includes('botDecisions'), 'capsule on')
    expect(await pane.clickToolbarTool('botDecisions')).toBe(true)
    await until(async () => (await pane.decisions()).groups.length === 3, 'groups rendered')

    const shot = await pane.decisions()
    expect(shot.present).toBe(true)
    expect(shot.empty).toBe(false)
    // 组间 seq 降序，无 seq 记录归入 '-1' 组置底
    expect(shot.groups.map((g) => g.seq)).toEqual(['5', '3', '-1'])
    // 组头：有 seq 的是 `#<seq> · …`，无 seq 组以 '·' 起头
    expect(shot.groups[0].header.startsWith('#5')).toBe(true)
    expect(shot.groups[1].header.startsWith('#3')).toBe(true)
    expect(shot.groups[2].header.startsWith('·')).toBe(true)
    // 组内跨目录按 ts 升序合并；kind 全部等宽原文 —— 未知值（zz_custom_kind）照渲
    expect(shot.groups[0].kinds).toEqual(['zz_custom_kind'])
    expect(shot.groups[1].kinds).toEqual(['claim_won', 'run_end'])
    expect(shot.groups[2].kinds).toEqual(['mailbox_timeout'])
    expect(shot.groups.every((g) => g.monoAll)).toBe(true)
  })
})

describe('活链（A4-35）', () => {
  it('先开面板（空态 "—"）→ 跑一轮 probe → 不点刷新，记录自己长出且与 IPC 回读一致', async () => {
    const sid = await createBotSession(app.main, { bots: ['d-probe'], title: 'A4-D35' })
    await until(async () => (await sidebar.titles()).includes('A4-D35'), 'row listed')
    await open('A4-D35')
    await until(async () => (await pane.toolbarTools()).includes('botDecisions'), 'capsule on')
    expect(await pane.clickToolbarTool('botDecisions')).toBe(true)

    // 面板先开：还没有任何记录 —— 空态占位 '—'
    await until(async () => (await pane.decisions()).present, 'panel mounted')
    await until(async () => (await pane.decisions()).empty, 'empty placeholder')
    expect((await pane.decisions()).groups).toEqual([])

    // 跑一轮（claim → say → run_end）。此后**不碰刷新按钮** —— 在飞活动收摊
    // （ended 删键）就是面板的刷新时机
    await prompt(sid, '给决策面板产一轮记录')

    await until(async () => {
      const [shot, ipc] = await Promise.all([pane.decisions(), readDecisions(sid)])
      const dom = shot.groups.flatMap((g) => g.kinds)
      if (dom.length === 0 || ipc.length === 0) return false
      return JSON.stringify([...dom].sort()) === JSON.stringify(ipc.map((r) => r.kind).sort())
    }, 'panel grew records matching IPC readback')

    // 收敛后的终态：确实有记录、空态占位已让位
    const finalShot = await pane.decisions()
    expect(finalShot.empty).toBe(false)
    expect(finalShot.groups.length).toBeGreaterThan(0)
    const ipc = await readDecisions(sid)
    expect(ipc.map((r) => r.kind)).toContain('run_end')
  })
})
