/**
 * 输入框 `@` 引用多源扩展 —— 合并弹层（裸 @）/ 显式路由 / 消歧与混排 / 启用配置时序 /
 * 发送展开与持久化 / 退格与草稿回退。
 *
 * 断言分层：候选范围首选 IPC（`window.api.mentions.listKnowledgeEntries`）；弹层行 / 段头 /
 * 镜像层胶囊走 pages.ts（DOM 只认 data-at-* 锚点）；发给模型的文本看
 * `fakeProvider.chatRequests()[i].lastUserText`；落库看 `window.api.message.list`。
 *
 * 种子约定（seedKnowledgeBase 的说明同样适用）：知识库条目必须**在会话于 UI 里激活之前**
 * 铺好 —— 渲染端 provider 按 sessionId 缓存候选表。AT-14 / AT-15 是「会话激活后改启用库
 * 选择要即时反映到候选」的期望用例：它们依赖 knowledge provider 同时订阅
 * `session.configChanged`（updateKnowledgeBases 的广播；修复前候选表只在 knowledge.changed
 * 时重扫，启用勾选变了弹层也不会变 —— 即 D-1）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  seedKnowledgeBase,
  seedProjectKnowledgeBase,
  waitRendererReady,
  type EventRecorder,
  type KnowledgeEntrySeed
} from '../../harness/seed'
import {
  atPopoverPane,
  chatPane,
  sidebarPane,
  type AtPopoverPane,
  type AtSuggestionRow,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'

/** 行锚点（data-at-suggestion 的值）：知识条目 = `knowledge:` + 条目 id */
const K_TOKEN = 'knowledge:knowledge/kb-a/notes/token-refresh.md'
const K_CONFIG_A = 'knowledge:knowledge/kb-a/notes/config-center.md'
const K_CONFIG_B = 'knowledge:knowledge/kb-b/guides/config-center.md'
/** 发送展开后的知识条目指针（buildAtToken 的逐字契约） */
const POINTER_TOKEN = '[knowledge entry: base kb-a, path /notes/token-refresh.md — Token 刷新]'
const POINTER_CONFIG_A = '[knowledge entry: base kb-a, path /notes/config-center.md — 配置中心]'
const POINTER_CONFIG_B = '[knowledge entry: base kb-b, path /guides/config-center.md — 配置中心]'
const POINTER_PROJ = '[knowledge entry: base project, path /notes/current-proj.md — 项目手册]'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  metadata?: {
    inlineTokens?: Record<
      string,
      { type: string; id: string; displayText: string; payload: string; name?: string }
    >
  } | null
}

interface MentionEntry {
  path: string
  baseName: string
  bundlePath: string
  title: string
  description: string
  bundleLabel: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let popover: AtPopoverPane
let projectId = ''
let K_PROJ = ''
const sids: Record<string, string> = {}

const entries = (path: string, title: string, description?: string): KnowledgeEntrySeed => ({
  path,
  title,
  ...(description ? { description } : {})
})

/** 经 IPC 建项目会话（可选启用知识库），不建运行时 —— 弹层用例不需要 LLM */
const createSession = async (
  title: string,
  knowledgeBases: string[] | undefined,
  pid: string
): Promise<string> => {
  const createParams = JSON.stringify({ title, projectId: pid })
  const kb = knowledgeBases ? JSON.stringify(knowledgeBases) : null
  return app.main.eval<string>(
    `(async () => {
      const s = await window.api.session.create(${createParams})
      ${kb ? `await window.api.session.updateKnowledgeBases({ id: s.id, knowledgeBases: ${kb} })` : ''}
      return s.id
    })()`
  )
}

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 末一条用户消息（同一会话被多条用例复用时，拿的是本条用例刚发的那条） */
const lastUserMessage = async (sid: string): Promise<ListedMessage> => {
  const user = (await listMessages(sid)).filter((m) => m.role === 'user').at(-1)
  if (!user) throw new Error(`no user message in ${sid}`)
  return user
}

const listKnowledgeEntries = (sid: string): Promise<MentionEntry[]> =>
  app.main.eval<MentionEntry[]>(
    `window.api.mentions.listKnowledgeEntries(${JSON.stringify({ sessionId: sid })})`
  )

/** 切到某会话并打出触发文本（type 全量替换 → 旧引用登记随之被 prune） */
const openAndType = async (title: string, text: string): Promise<void> => {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  await chat.type(text)
}

/** 等弹层出现某行并回行快照 */
const waitRow = (key: string, what = `popover row ${key}`): Promise<AtSuggestionRow> =>
  until(async () => (await popover.rows()).find((r) => r.key === key) ?? null, what)

/** 当前键盘选中行的扁平索引（无选中返回 -1） */
const selectedIndex = async (): Promise<number> =>
  (await popover.rows()).findIndex((r) => r.selected)

/** 等方向键导航落定到目标索引 */
const waitSelected = (idx: number): Promise<unknown> =>
  until(async () => ((await selectedIndex()) === idx ? true : null), `selected index ${idx}`)

/** 脚本化一轮回复并发送当前输入框内容，等该轮落定 */
const sendAndSettle = async (sid: string): Promise<void> => {
  await chat.pressEnter()
  await events.waitFor('agent_end', { sessionId: sid })
  await chat.waitIdle()
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 工作区文件：README（裸 @ 空 query 的浅层行）、docs/alpha-*（显式路由对照 / 文件回归）、
  // pool/common-01..07（每源 ≤5 的文件侧样本）。**两个项目**：侧栏每个分组只渲染最近
  // GROUP_VISIBLE_LIMIT(20) 条（ProjectSessionGroups），24 条会话塞同一组会把最老的
  // 几条收进「显示更多」、openSession 按标题找不到 —— 拆两组，每组都远低于上限。
  const writeFiles = (projDir: string, files: string[]): void => {
    for (const rel of files) {
      const p = join(projDir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, `# ${rel}\n`)
    }
  }
  const projDir = join(app.home, 'proj-at')
  writeFiles(projDir, [
    'README.md',
    'docs/alpha-guide.md',
    'docs/alpha-notes.md',
    ...Array.from({ length: 7 }, (_, i) => `pool/common-0${i + 1}.md`)
  ])
  const projDir2 = join(app.home, 'proj-at-b')
  writeFiles(projDir2, ['README.md', 'docs/alpha-guide.md', 'docs/alpha-notes.md'])
  const project = await createProject(app.main, { name: 'AtProj', path: projDir })
  projectId = project.id
  const project2 = await createProject(app.main, { name: 'AtProjB', path: projDir2 })
  K_PROJ = `knowledge:projects/${projectId}/notes/current-proj.md`

  // 知识库种子（全部在会话激活前铺好）：
  //   kb-a    Token 刷新 + 配置中心（消歧的 A 侧）     kb-b  配置中心（B 侧）+ 乙库专属
  //   kb-empty 空库（知识段不该出现）                   kb-7  7 条同前缀（每源 ≤5 的知识侧样本）
  seedKnowledgeBase(app, 'kb-a', [
    entries('notes/token-refresh.md', 'Token 刷新', '如何刷新访问令牌'),
    entries('notes/config-center.md', '配置中心')
  ])
  seedKnowledgeBase(app, 'kb-b', [
    entries('guides/config-center.md', '配置中心'),
    entries('guides/only-b.md', '乙库专属条目')
  ])
  seedKnowledgeBase(app, 'kb-empty', [])
  seedKnowledgeBase(
    app,
    'kb-7',
    Array.from({ length: 7 }, (_, i) => entries(`items/e${i + 1}.md`, `common 条目 ${i + 1}`))
  )
  seedProjectKnowledgeBase(app, projectId, [entries('notes/current-proj.md', '项目手册')])

  // A/B/C/D 组 + 项目库用例在 AtProj（含切走对照共 17 条）；E/F 组在 AtProjB（8 条）
  const inP1 = (title: string, kb?: string[]): Promise<string> =>
    createSession(title, kb, project.id)
  const inP2 = (title: string, kb?: string[]): Promise<string> =>
    createSession(title, kb, project2.id)
  sids['AT-1'] = await inP1('AT-1', ['kb-a'])
  sids['AT-2'] = await inP1('AT-2', undefined)
  sids['AT-3'] = await inP1('AT-3', ['kb-empty'])
  sids['AT-4'] = await inP1('AT-4', ['kb-7'])
  sids['AT-5'] = await inP1('AT-5', ['kb-a'])
  sids['AT-6'] = await inP1('AT-6', ['kb-a'])
  sids['AT-7'] = await inP1('AT-7', ['kb-a'])
  sids['AT-8'] = await inP1('AT-8', ['kb-a'])
  sids['AT-9'] = await inP1('AT-9', undefined)
  sids['AT-10'] = await inP1('AT-10', ['kb-a'])
  sids['AT-11'] = await inP1('AT-11', ['kb-a', 'kb-b'])
  sids['AT-13'] = await inP1('AT-13', ['kb-a'])
  sids['AT-14'] = await inP1('AT-14', undefined)
  sids['AT-15'] = await inP1('AT-15', ['kb-a'])
  sids['AT-16'] = await inP1('AT-16', ['kb-a'])
  sids['AT-20'] = await inP1('AT-20', ['project'])
  sids.scratch = await inP1('AT-scratch', undefined)
  sids['AT-17'] = await inP2('AT-17', ['kb-a'])
  sids['AT-21'] = await inP2('AT-21', undefined)
  sids['AT-22'] = await inP2('AT-22', ['kb-a'])
  sids['AT-23'] = await inP2('AT-23', ['kb-a'])
  sids['AT-24'] = await inP2('AT-24', ['kb-a', 'kb-b'])
  sids['AT-25'] = await inP2('AT-25', ['kb-a'])
  sids['AT-26'] = await inP2('AT-26', ['kb-a'])
  sids.scratchE = await inP2('AT-scratch-e', undefined)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  popover = atPopoverPane(app.main)
  await until(async () => {
    const titles = await sidebar.titles()
    return titles.includes('AT-1') && titles.includes('AT-scratch-e')
  }, 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('A · 合并弹层（裸 @）', () => {
  it('AT-1 裸 @ 两段分区 + 段头', async () => {
    await openAndType('AT-1', '@')
    await waitRow(K_TOKEN)
    const rows = await popover.rows()
    // 文件行与知识行同时在屏
    expect(rows.some((r) => r.key === 'README.md')).toBe(true)
    expect(rows.some((r) => r.key === K_TOKEN)).toBe(true)
    // 两个段头（文件在前、知识库在后 = provider 注册序）
    expect(await popover.sections()).toEqual(['file', 'knowledge'])
  })

  it('AT-2 未启用任何库 → 只出文件段、无段头；IPC 候选为空', async () => {
    await openAndType('AT-2', '@')
    await waitRow('README.md')
    const rows = await popover.rows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => !r.key.startsWith('knowledge:'))).toBe(true)
    expect(await popover.sections()).toEqual([])
    expect(await listKnowledgeEntries(sids['AT-2'])).toEqual([])
  })

  it('AT-3 启用空库 → 知识段不出现（观感同未启用）', async () => {
    await openAndType('AT-3', '@')
    await waitRow('README.md')
    // 空库条目是 0 条：断言跨过一个落定窗口后知识行仍不出现
    await sleep(400)
    const rows = await popover.rows()
    expect(rows.every((r) => !r.key.startsWith('knowledge:'))).toBe(true)
    expect(await popover.sections()).toEqual([])
  })

  it('AT-4 每源 ≤5（两源各种 7 条同前缀）', async () => {
    await openAndType('AT-4', '@common')
    await until(async () => {
      const rows = await popover.rows()
      const fileRows = rows.filter((r) => !r.key.startsWith('knowledge:'))
      const knowledgeRows = rows.filter((r) => r.key.startsWith('knowledge:'))
      return fileRows.length > 0 && knowledgeRows.length > 0 ? { fileRows, knowledgeRows } : null
    }, 'both sources offer rows')
    const rows = await popover.rows()
    const fileRows = rows.filter((r) => !r.key.startsWith('knowledge:'))
    const knowledgeRows = rows.filter((r) => r.key.startsWith('knowledge:'))
    // 各种 7 条候选，弹层各截到 5
    expect(fileRows).toHaveLength(5)
    expect(knowledgeRows).toHaveLength(5)
    expect(fileRows.every((r) => r.key.startsWith('pool/common-'))).toBe(true)
  })

  it('AT-5 方向键跨段扁平循环 + 回卷 + Enter 选中', async () => {
    await openAndType('AT-5', '@')
    await waitRow(K_TOKEN)
    const total = (await popover.rows()).length
    // 5 文件 + 2 知识 = 7 行；初始选中第 0 行
    expect(total).toBe(7)
    await waitSelected(0)

    // 扁平序逐行迁移（跨段不需要任何特殊操作）
    for (const want of [1, 2, 3, 4, 5, 6]) {
      await chat.pressKey('ArrowDown')
      await waitSelected(want)
    }
    // 末行 ArrowDown 回卷到 0；0 上 ArrowUp 回卷到末行
    await chat.pressKey('ArrowDown')
    await waitSelected(0)
    await chat.pressKey('ArrowUp')
    await waitSelected(6)

    // Enter 选当前行（末行 = 知识条目 Token 刷新）：插明文（含尾随空格）并关弹层
    await chat.pressKey('Enter')
    await until(
      async () => (await chat.inputValue()) === '@knowledge:Token 刷新 ',
      'mention inserted'
    )
    expect(await popover.open()).toBe(false)
  })

  it('AT-6 候选范围 = 启用库（种 kb-a/kb-b 只启用 kb-a）', async () => {
    // IPC 口径：启用库硬边界 —— 全部条目都来自 kb-a
    const entries = await listKnowledgeEntries(sids['AT-6'])
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.baseName === 'kb-a')).toBe(true)

    // DOM 口径：弹层里没有 kb-b 的行
    await openAndType('AT-6', '@')
    await waitRow(K_TOKEN)
    const rows = await popover.rows()
    expect(rows.some((r) => r.key.startsWith('knowledge:'))).toBe(true)
    expect(rows.every((r) => !r.key.includes('kb-b'))).toBe(true)
  })

  it('AT-7 Esc 关闭弹层；切会话收起弹层', async () => {
    await openAndType('AT-7', '@')
    await waitRow(K_TOKEN)
    await chat.pressKey('Escape')
    await until(async () => !(await popover.open()), 'popover closed by Esc')

    // 文本已是 '@'：React 对同值 input 事件去重，先清空再敲才能重新触发 onChange
    await chat.type('')
    await chat.type('@')
    await waitRow(K_TOKEN)
    expect(await sidebar.openSession('AT-scratch')).toBe(true)
    await until(async () => !(await popover.open()), 'popover collapsed on session switch')
  })
})

describe('B · 显式路由', () => {
  it('AT-8 @knowledge: 只出知识行；选中插明文（尾随空格）且镜像层胶囊同文本', async () => {
    await openAndType('AT-8', '@knowledge:Token')
    const row = await waitRow(K_TOKEN)
    const rows = await popover.rows()
    expect(rows.every((r) => r.key.startsWith('knowledge:'))).toBe(true)

    expect(await popover.select(row.key)).toBe(true)
    expect(await chat.inputValue()).toBe('@knowledge:Token 刷新 ')
    // 镜像层胶囊文字与底层 textarea 逐字一致（含前导 @，不含尾随空格）
    expect(await chat.composerChips()).toEqual(['@knowledge:Token 刷新'])
  })

  it('AT-9 @file:前缀 只出文件行，与裸 @前缀 文件行集合一致', async () => {
    await openAndType('AT-9', '@file:alpha')
    await until(async () => (await popover.rows()).length === 2, 'routed file rows')
    const routed = (await popover.rows()).map((r) => r.key).sort()
    expect(routed.every((k) => !k.startsWith('knowledge:'))).toBe(true)

    await chat.type('@alpha')
    await until(async () => (await popover.rows()).length === 2, 'merged file rows')
    const merged = (await popover.rows()).map((r) => r.key).sort()
    expect(merged).toEqual(routed)
    expect(merged).toEqual(['docs/alpha-guide.md', 'docs/alpha-notes.md'])
  })

  it('AT-10 未注册前缀按默认源处理（无匹配 → 弹层不开）；对照 @knowledge: 有行', async () => {
    await openAndType('AT-10', '@foo:Token')
    // `foo` 不是已注册源 → 整体 `foo:Token` 作为默认源 query，无匹配 → 弹层不开
    await sleep(400)
    expect(await popover.open()).toBe(false)

    await chat.type('@knowledge:Token')
    await waitRow(K_TOKEN)
    expect((await popover.rows()).every((r) => r.key.startsWith('knowledge:'))).toBe(true)
  })
})

describe('C · 消歧与混排', () => {
  /** 先后选中 kb-a / kb-b 的同名「配置中心」，回最终明文 */
  const selectBothConfigCenters = async (title: string): Promise<string> => {
    await openAndType(title, '@knowledge:配置')
    await waitRow(K_CONFIG_A)
    expect(await popover.select(K_CONFIG_A)).toBe(true)
    expect(await chat.inputValue()).toBe('@knowledge:配置中心 ')

    // 继续在同一输入里选第二个（部分 query 重新触发弹层）
    await chat.type('@knowledge:配置中心 @knowledge:配置')
    await waitRow(K_CONFIG_B)
    expect(await popover.select(K_CONFIG_B)).toBe(true)
    return chat.inputValue()
  }

  it('AT-11 同名撞车：第二次选中追加消歧后缀，先选中的不回改', async () => {
    const value = await selectBothConfigCenters('AT-11')
    expect(value).toBe('@knowledge:配置中心 @knowledge:配置中心 (kb-b) ')
    expect(await chat.composerChips()).toEqual([
      '@knowledge:配置中心',
      '@knowledge:配置中心 (kb-b)'
    ])
  })

  it('AT-12 两个 at token 各指各库；lastUserText 两条指针；气泡两颗胶囊', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await selectBothConfigCenters('AT-11')
    await sendAndSettle(sids['AT-11'])

    const user = await lastUserMessage(sids['AT-11'])
    const tokens = Object.values(user.metadata?.inlineTokens ?? {})
    expect(tokens).toHaveLength(2)
    const payloads = tokens.map((t) => t.payload).sort()
    expect(payloads).toEqual([POINTER_CONFIG_A, POINTER_CONFIG_B].sort())
    expect(tokens.every((t) => t.type === 'at')).toBe(true)

    expect(provider.chatRequests()[0].lastUserText).toContain(POINTER_CONFIG_A)
    expect(provider.chatRequests()[0].lastUserText).toContain(POINTER_CONFIG_B)

    expect(await chat.tokenBadges(user.id)).toEqual([
      'knowledge:配置中心',
      'knowledge:配置中心 (kb-b)'
    ])
  })

  it('AT-13 文件 + 知识 + 普通文字混排发送：两个 at token，周围文字原样', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await openAndType('AT-13', '@alpha')
    await waitRow('docs/alpha-guide.md')
    expect(await popover.select('docs/alpha-guide.md')).toBe(true)

    await chat.type('@alpha-guide.md 请结合 @knowledge:Token')
    await waitRow(K_TOKEN)
    expect(await popover.select(K_TOKEN)).toBe(true)
    await chat.type('@alpha-guide.md 请结合 @knowledge:Token 刷新 说明一下')
    await sendAndSettle(sids['AT-13'])

    const user = await lastUserMessage(sids['AT-13'])
    const tokens = Object.values(user.metadata?.inlineTokens ?? {})
    expect(tokens).toHaveLength(2)
    const fileToken = tokens.find((t) => t.id === 'docs/alpha-guide.md')
    const knowledgeToken = tokens.find((t) => t.id === K_TOKEN)
    expect(fileToken?.payload).toBe('[workspace file: docs/alpha-guide.md]')
    expect(knowledgeToken?.payload).toBe(POINTER_TOKEN)
    // 标记留在 content 里，周围文字原样
    expect(user.content).toContain('请结合')
    expect(user.content).toContain('说明一下')

    const sent = provider.chatRequests()[0].lastUserText
    expect(sent).toBe(`[workspace file: docs/alpha-guide.md] 请结合 ${POINTER_TOKEN} 说明一下`)
  })
})

describe('D · 启用配置时序', () => {
  it('AT-14 会话已激活且拉过候选（无库）→ mid-session 启用 kb-a → 知识行出现', async () => {
    await openAndType('AT-14', '@')
    await waitRow('README.md')
    // 此刻无库：无知识行，IPC 候选为空（候选表已按 sessionId 缓存）
    expect((await popover.rows()).every((r) => !r.key.startsWith('knowledge:'))).toBe(true)
    expect(await listKnowledgeEntries(sids['AT-14'])).toEqual([])

    await app.main.eval(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sids['AT-14'], knowledgeBases: ['kb-a'] })})`
    )
    // 弹层不必重开：会话配置变更广播驱动 knowledge provider 重拉（D-1 修复前这里恒超时）
    await waitRow(K_TOKEN, 'knowledge rows appear after mid-session enable')
  })

  it('AT-15 反向：已出知识行 → 设回 [] → 知识行消失', async () => {
    await openAndType('AT-15', '@')
    await waitRow(K_TOKEN)

    await app.main.eval(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sids['AT-15'], knowledgeBases: [] })})`
    )
    await until(async () => {
      const rows = await popover.rows()
      return rows.length > 0 && rows.every((r) => !r.key.startsWith('knowledge:')) ? true : null
    }, 'knowledge rows gone after disable')
  })

  it('AT-16 knowledge:createEntry 广播 knowledge.changed → 防抖后新条目出现在候选', async () => {
    await openAndType('AT-16', '@knowledge:新增')
    // 此刻无匹配 → 弹层不开
    await sleep(400)
    expect(await popover.open()).toBe(false)

    const created = await app.main.eval<{ success: boolean; id?: string }>(
      `window.api.knowledge.createEntry(${JSON.stringify({ dir: 'knowledge/kb-a', title: '新增条目' })})`
    )
    expect(created.success).toBe(true)
    // 触发态仍在（query 未变）：重扫完成后候选自动出现
    await until(
      async () => (await popover.rows()).find((r) => r.key === `knowledge:${created.id}`) ?? null,
      'newly created entry in candidates'
    )
  })
})

describe('E · 发送展开与持久化', () => {
  /** 选中 Token 刷新并发送，回落库的用户消息 */
  const sendKnowledgeRef = async (title: string): Promise<ListedMessage> => {
    await openAndType(title, '@knowledge:Token')
    await waitRow(K_TOKEN)
    expect(await popover.select(K_TOKEN)).toBe(true)
    expect(await chat.inputValue()).toBe('@knowledge:Token 刷新 ')
    await sendAndSettle(sids[title])
    return lastUserMessage(sids[title])
  }

  it('AT-17 发送展开为知识条目指针，模型侧不见标记也不见明文', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await sendKnowledgeRef('AT-17')
    const sent = provider.chatRequests()[0].lastUserText
    expect(sent).toContain(POINTER_TOKEN)
    expect(sent).not.toContain('{{shuvixInlineToken:')
    expect(sent).not.toContain('@knowledge:')
  })

  it('AT-18 落库：content 含标记；inlineTokens 恰一条且逐字对', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    const user = await sendKnowledgeRef('AT-17')
    expect(user.content).toContain('{{shuvixInlineToken:')
    const dict = user.metadata?.inlineTokens ?? {}
    expect(Object.keys(dict)).toHaveLength(1)
    expect(Object.values(dict)[0]).toEqual({
      type: 'at',
      id: K_TOKEN,
      displayText: 'knowledge:Token 刷新',
      payload: POINTER_TOKEN,
      name: 'Token 刷新'
    })
  })

  it('AT-19 气泡胶囊持久化渲染：切走再切回仍在', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    const user = await sendKnowledgeRef('AT-17')
    expect(await chat.tokenBadges(user.id)).toEqual(['knowledge:Token 刷新'])

    expect(await sidebar.openSession('AT-scratch-e')).toBe(true)
    expect(await sidebar.openSession('AT-17')).toBe(true)
    await until(async () => (await chat.settledItems()).length >= 2, 'session reopened')
    expect(await chat.tokenBadges(user.id)).toEqual(['knowledge:Token 刷新'])
  })

  it('AT-20 项目库：行 detail = 项目当前名；payload base project；IPC baseName project', async () => {
    const ipcEntries = await listKnowledgeEntries(sids['AT-20'])
    expect(ipcEntries).toHaveLength(1)
    expect(ipcEntries[0].baseName).toBe('project')
    expect(ipcEntries[0].path).toBe(`projects/${projectId}/notes/current-proj.md`)

    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await openAndType('AT-20', '@knowledge:项目手册')
    const row = await waitRow(K_PROJ)
    expect(row.label).toBe('项目手册')
    expect(row.detail).toBe('AtProj')

    expect(await popover.select(K_PROJ)).toBe(true)
    await sendAndSettle(sids['AT-20'])
    expect(provider.chatRequests()[0].lastUserText).toContain(POINTER_PROJ)
  })

  it('AT-21 文件引用回归：裸 @ 选文件发送（零迁移契约）', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await openAndType('AT-21', '@alpha')
    await waitRow('docs/alpha-guide.md')
    expect(await popover.select('docs/alpha-guide.md')).toBe(true)
    expect(await chat.inputValue()).toBe('@alpha-guide.md ')
    await sendAndSettle(sids['AT-21'])

    const user = await lastUserMessage(sids['AT-21'])
    const tokens = Object.values(user.metadata?.inlineTokens ?? {})
    expect(tokens).toEqual([
      {
        type: 'at',
        id: 'docs/alpha-guide.md',
        displayText: 'alpha-guide.md',
        payload: '[workspace file: docs/alpha-guide.md]',
        name: 'alpha-guide.md'
      }
    ])
    expect(provider.chatRequests()[0].lastUserText).toContain(
      '[workspace file: docs/alpha-guide.md]'
    )
    expect(await chat.tokenBadges(user.id)).toEqual(['alpha-guide.md'])
  })

  it('AT-22 同一条目引用两次 → 单 token 双标记', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await openAndType('AT-22', '@knowledge:Token')
    await waitRow(K_TOKEN)
    expect(await popover.select(K_TOKEN)).toBe(true)

    // 再引用一次同一目标：部分 query 重新触发，选中后明文相同、实体相同
    await chat.type('@knowledge:Token 刷新 再说一次 @knowledge:Token')
    await waitRow(K_TOKEN)
    expect(await popover.select(K_TOKEN)).toBe(true)
    expect(await chat.inputValue()).toBe('@knowledge:Token 刷新 再说一次 @knowledge:Token 刷新 ')
    await sendAndSettle(sids['AT-22'])

    const user = await lastUserMessage(sids['AT-22'])
    const dict = user.metadata?.inlineTokens ?? {}
    expect(Object.keys(dict)).toHaveLength(1)
    expect(user.content.match(/\{\{shuvixInlineToken:/g)).toHaveLength(2)
    const sent = provider.chatRequests()[0].lastUserText
    expect(sent).toBe(`${POINTER_TOKEN} 再说一次 ${POINTER_TOKEN}`)
  })
})

describe('F · 退格与草稿回退', () => {
  it('AT-23 光标紧贴引用尾部退格 → 整颗 @knowledge:X 一次删光', async () => {
    await openAndType('AT-23', '@knowledge:Token')
    await waitRow(K_TOKEN)
    expect(await popover.select(K_TOKEN)).toBe(true)
    expect(await chat.composerChips()).toEqual(['@knowledge:Token 刷新'])

    // 尾随空格前一个字符 = 引用尾
    const value = await chat.inputValue()
    await chat.setCaret(value.length - 1)
    await chat.pressKey('Backspace')
    await until(async () => (await chat.inputValue()) === ' ', 'mention deleted whole')
    expect(await chat.composerChips()).toEqual([])
  })

  it('AT-24 带消歧后缀的引用同样整体删除（先选中的不受影响）', async () => {
    await openAndType('AT-24', '@knowledge:配置')
    await waitRow(K_CONFIG_A)
    expect(await popover.select(K_CONFIG_A)).toBe(true)
    await chat.type('@knowledge:配置中心 @knowledge:配置')
    await waitRow(K_CONFIG_B)
    expect(await popover.select(K_CONFIG_B)).toBe(true)
    const before = '@knowledge:配置中心 @knowledge:配置中心 (kb-b) '
    expect(await chat.inputValue()).toBe(before)

    await chat.setCaret(before.length - 1)
    await chat.pressKey('Backspace')
    // 第二颗（带后缀）整颗删光；第一颗明文与胶囊原样保留
    await until(
      async () => (await chat.inputValue()) === '@knowledge:配置中心  ',
      'disambiguated mention deleted whole'
    )
    expect(await chat.composerChips()).toEqual(['@knowledge:配置中心'])
  })

  it('AT-25 回退草稿重建引用：不重选直接重发，新一轮仍展开为完整指针', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'first' }, { text: 'second' })

    const user = await (async () => {
      await openAndType('AT-25', '@knowledge:Token')
      await waitRow(K_TOKEN)
      expect(await popover.select(K_TOKEN)).toBe(true)
      await sendAndSettle(sids['AT-25'])
      return lastUserMessage(sids['AT-25'])
    })()

    await chat.clickRollback(user.id)
    expect(await chat.confirmOpen()).toBe(true)
    await chat.confirmAccept()

    // 草稿回填的是明文（@displayText），不是裸标记；引用登记随之复活
    await until(
      async () => (await chat.inputValue()).includes('@knowledge:Token 刷新'),
      'draft rebuilt with plaintext mention'
    )
    expect(await chat.inputValue()).not.toContain('{{shuvixInlineToken:')
    expect(await chat.composerChips()).toEqual(['@knowledge:Token 刷新'])

    // 不重选直接重发：复活的引用照常构造 token 并展开
    await sendAndSettle(sids['AT-25'])
    expect(provider.chatRequests()).toHaveLength(2)
    expect(provider.chatRequests()[1].lastUserText).toContain(POINTER_TOKEN)
    expect(provider.chatRequests()[1].lastUserText).not.toContain('@knowledge:')
  })

  it('AT-26 明文被续写破坏（@knowledge:…XY）→ 发送无 inlineTokens、原文照发', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'ok' })

    await openAndType('AT-26', '@knowledge:Token')
    await waitRow(K_TOKEN)
    expect(await popover.select(K_TOKEN)).toBe(true)

    // 在引用尾部续写 → 边界不再成立，命中降级为普通文字
    await chat.type('@knowledge:Token 刷新XY')
    await sendAndSettle(sids['AT-26'])

    const user = await lastUserMessage(sids['AT-26'])
    expect(user.metadata?.inlineTokens ?? null).toBeNull()
    expect(user.content).toBe('@knowledge:Token 刷新XY')
    expect(provider.chatRequests()[0].lastUserText).toBe('@knowledge:Token 刷新XY')
  })
})
