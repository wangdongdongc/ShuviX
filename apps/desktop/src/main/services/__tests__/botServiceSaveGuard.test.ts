/**
 * bot md 的**丢更新守卫**与**改名迁移**（M9′）。
 *
 * 两件事凑在一起，是因为它们都只在「这份 md 会被两个人改」这个前提下才存在：
 * 用户在设置页里改，而这个 bot 的笔记段在后台改同一份文件。别处的 md（agent / policy /
 * workflow）没有第二个写者，所以这条守卫今天只有 bot 一条链路。
 *
 * - **SG-A 版本指纹**：`getSource` 那一刻的内容哈希；`save` 拿它对账，对不上就把盘上的
 *   内容交回 UI 去解决，而不是让后写的一方赢。
 * - **SG-B 改名迁移**：bot 的身份是 frontmatter 里的 `name`，而这个名字被三处引用。
 *   不迁的话，改一次名等于把这个 bot 从所有会话里删掉，而用户看到的是「我只是改了个名字」。
 *
 * mock 面：sessionService（名单改写的观测点）/ workflowService / paths / logger / 广播。
 * **fs 是真的** —— 指纹算的是盘上的字节，迁移搬的是盘上的目录，换成假 fs 一条也测不到。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botsave-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  rewriteBots: vi.fn(),
  getById: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: vi.fn(async () => ({ started: false, reason: 'not-found' })),
    abortSessionRuns: vi.fn(() => 0),
    hasWorkflow: vi.fn(() => true),
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: vi.fn() }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
// v2：聊天会话转写在 chat_messages 表里。真 DAO 一经导入就会打开 sqlite
// （DatabaseManager 构造即开库，而原生绑定是 Electron ABI 的），故整个替换成内存版
vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
vi.mock('../../utils/paths', () => ({
  // v2 起 botService 经 chatMessageDao 触到 DatabaseManager，它的构造读 getDataDir
  getDataDir: () => join(dirs.base, 'data'),
  getChatAttachmentsDir: (sid: string) => join(dirs.base, 'data', 'chat-attachments', sid),
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots,
  // botService → agentService 的模块作用域构造器在 import 阶段就要它
  getDefaultAgentsDir: () => `${dirs.base}/agents`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: vi.fn() } }))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    getById: mocks.getById,
    list: mocks.list,
    rewriteBots: mocks.rewriteBots
  }
}))
// botService 经 settingsService 读两道循环护栏。真件一经导入就把 settingsDao →
// dao/database 拉进模块图，而 DatabaseManager 构造即开 sqlite（原生绑定是 Electron ABI 的）
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))

import { botService } from '../botService'

const NOTES_MARKER = '<!-- shuvix:bot-notes -->'

/** 一份最小可解析的 bot md */
function md(
  name: string,
  opts: { body?: string; notes?: string; displayName?: string } = {}
): string {
  const lines = ['---', 'shuvix: bot v1', `name: ${name}`, `description: unit bot ${name}`]
  if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
  lines.push('---', '', opts.body ?? 'BOT BODY.')
  if (opts.notes !== undefined) lines.push('', NOTES_MARKER, '', opts.notes)
  return lines.join('\n')
}

/** 直接往目录里放一份 md（文件名与 name 可以不同 —— 那正是「迁移做了一半」的形态） */
function put(fileBase: string, text: string): string {
  mkdirSync(dirs.bots, { recursive: true })
  const filePath = join(dirs.bots, `${fileBase}.md`)
  writeFileSync(filePath, text)
  return filePath
}

const sourceOf = (name: string): { text: string; revision: string } =>
  botService.getSource(name) as { text: string; revision: string }

/** `~/.shuvix/bots/.runs/<bot>/` —— 决策记录与 run journal 同住的那个目录 */
const runsDir = (botName: string): string => join(dirs.bots, '.runs', botName)

/**
 * 会话表的**可变**替身。`rewriteBots` 真的写回去 —— 迁移会连着跑两趟（一次正常改名，
 * 一次「补做」自检），只有让第二趟看得见第一趟的结果，断言才是生产里的那个形状。
 */
let sessionRows: Array<{ id: string; settings: { bots?: string[] } }> = []

function seedSessions(rows: Array<{ id: string; bots?: string[] }>): void {
  sessionRows = rows.map((r) => ({ id: r.id, settings: r.bots ? { bots: [...r.bots] } : {} }))
}

/** 某条会话此刻的成员名单 */
const botsOf = (id: string): string[] | undefined =>
  sessionRows.find((r) => r.id === id)?.settings.bots

/** rewriteBots 收到过的会话 id（按调用序） */
const rewrittenIds = (): string[] => mocks.rewriteBots.mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  for (const m of Object.values(mocks)) m.mockReset()
  sessionRows = []
  mocks.list.mockImplementation(() => sessionRows)
  mocks.rewriteBots.mockImplementation((id: string, bots: string[]) => {
    const row = sessionRows.find((r) => r.id === id)
    if (row) row.settings.bots = bots
  })
  mocks.getById.mockReturnValue(null)
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

// ────────────────────── SG-A：版本指纹（丢更新守卫） ──────────────────────

/**
 * 守的是这条时序：**T0 用户打开编辑器 → T1 笔记段改了这份文件 → T2 用户按保存**。
 * 没有守卫的话 T2 会把 T1 的整份归纳吃掉，而且是静默的 —— `edit` 工具自带的
 * 「读后被改」检测保护的是 agent 那一侧，反方向从来没有人守。
 */
describe('SG-A —— 版本指纹', () => {
  it('SG-A1 getSource 连原文一起给一枚指纹（内容哈希，不是 mtime）', () => {
    // 用 mtime 会漏掉最该拦的那一种：笔记段的写入与用户的保存可以落在同一秒里，
    // 而 mtime 的分辨率恰好把这种情况判成「没变」
    put('scout', md('scout'))
    const got = sourceOf('scout')
    expect(got.text).toContain('name: scout')
    expect(got.revision).toMatch(/^[0-9a-f]{16}$/)
  })

  it('SG-A2 指纹是内容的函数：同内容同指纹，差一个字节就变', () => {
    put('scout', md('scout'))
    const first = sourceOf('scout').revision
    put('scout', md('scout'))
    expect(sourceOf('scout').revision).toBe(first)

    put('scout', md('scout', { notes: '多了一条笔记' }))
    expect(sourceOf('scout').revision).not.toBe(first)
  })

  it('SG-A3 指纹对得上 → 保存成功，并回一枚**新**指纹', () => {
    put('scout', md('scout'))
    const { revision } = sourceOf('scout')
    const next = md('scout', { body: '改过的正文。' })

    const res = botService.save('scout', next, revision)
    expect(res.success).toBe(true)
    expect(readFileSync(join(dirs.bots, 'scout.md'), 'utf-8')).toBe(next)
    // 回新指纹是为了让 UI 能接着存第二次 —— 否则第二次必然拿着过期的指纹误报冲突
    expect(res.revision).toBe(sourceOf('scout').revision)
  })

  it('SG-A4 连存两次：第二次拿第一次回的指纹，仍然成功', () => {
    put('scout', md('scout'))
    const first = botService.save(
      'scout',
      md('scout', { body: '第一改' }),
      sourceOf('scout').revision
    )
    const second = botService.save('scout', md('scout', { body: '第二改' }), first.revision)
    expect(second.success).toBe(true)
    expect(readFileSync(join(dirs.bots, 'scout.md'), 'utf-8')).toContain('第二改')
  })

  it('SG-A5 指纹对不上 → 拒绝，并把**盘上的当前内容**交回 UI 去解决冲突', () => {
    put('scout', md('scout'))
    const stale = sourceOf('scout').revision
    // 笔记段在这中间改了这份文件
    const onDisk = md('scout', { notes: '用户偏好简答。' })
    put('scout', onDisk)

    const res = botService.save('scout', md('scout', { body: '用户这边的改动' }), stale)
    expect(res.success).toBe(false)
    expect(res.conflict?.current).toBe(onDisk)
    expect(res.error).toContain('changed on disk')
    // 拒绝是真的没写 —— 盘上还是笔记段那一份
    expect(readFileSync(join(dirs.bots, 'scout.md'), 'utf-8')).toBe(onDisk)
  })

  it('SG-A6 revision 是空串算「对不上」，不是「没传」', () => {
    // `revision: ''` 走了「没传」那一支的话，守卫会在最容易踩的那种调用上静默失效
    put('scout', md('scout'))
    const res = botService.save('scout', md('scout', { body: 'x' }), '')
    expect(res.success).toBe(false)
    expect(res.conflict?.current).toContain('name: scout')
  })

  it('SG-A7 不传 revision → 按旧语义直接覆盖（坏文件的修复通道没有可对照的版本）', () => {
    put('scout', md('scout'))
    const next = md('scout', { body: '直接覆盖' })
    expect(botService.save('scout', next).success).toBe(true)
    expect(readFileSync(join(dirs.bots, 'scout.md'), 'utf-8')).toBe(next)
  })

  it('SG-A8 冲突内容是**盘上的原始字节**（按路径读，不重新序列化）', () => {
    // UI 拿它做三方合并，所以它必须逐字节等于盘上那一份 —— 任何一次「解析再吐出来」
    // 都会顺手规整掉空行与键序，而用户看到的差异里就会混进一堆不是笔记段改的东西
    put('scout', md('scout'))
    const stale = sourceOf('scout').revision
    const messy = `${md('scout')}\n\n${NOTES_MARKER}\n\n\n## 偏好\n\n- 简答   \n\n\n`
    put('scout', messy)

    const res = botService.save('scout', md('scout', { body: '用户这边' }), stale)
    expect(res.success).toBe(false)
    expect(res.conflict?.current).toBe(messy)
  })

  it('SG-A8b 笔记段连名字一起改了 → 这次保存被拒，而不是把它盖回去', () => {
    // 定位是按 `originalName` 查的，盘上的 name 已经不是它了 —— 此时唯一安全的动作是
    // 拒绝：用户手里那份是照着旧名编辑的，写下去等于把笔记段改的名字连同笔记一起吃掉
    put('scout', md('scout'))
    const renamedOnDisk = md('ranger', { notes: '它把自己改名了' })
    put('scout', renamedOnDisk)

    const res = botService.save('scout', md('scout', { body: '用户这边' }))
    expect(res.success).toBe(false)
    expect(readFileSync(join(dirs.bots, 'scout.md'), 'utf-8')).toBe(renamedOnDisk)
  })

  it('SG-A9 指纹这一关排在解析校验之前 —— 冲突的文件不该先被挑语法毛病', () => {
    // 顺序反过来的话，用户拿到的是「你的 md 有语法错」，而真正发生的是「有人改了这份文件」
    put('scout', md('scout'))
    const stale = sourceOf('scout').revision
    put('scout', md('scout', { notes: '后台改的' }))

    const res = botService.save('scout', '这根本不是一份合法的 md', stale)
    expect(res.success).toBe(false)
    expect(res.conflict).toBeDefined()
  })

  it('SG-A10 名字不存在 → 报找不到（守卫之前先得有这个 bot）', () => {
    expect(botService.save('ghost', md('ghost'), 'deadbeefdeadbeef')).toEqual({
      success: false,
      error: 'Bot "ghost" not found'
    })
  })
})

// ────────────────────── SG-B：改名迁移 ──────────────────────

/**
 * 名字被三处引用：会话的 `settings.bots` 成员名单、决策记录与 run journal 的目录、
 * 以及笔记检查点。每一步都先看目标状态再动手 —— 迁移做了一半崩掉时，下一次保存能把
 * 剩下的补上（SG-B7 就是那次补做）。
 */
describe('SG-B —— 改名迁移', () => {
  /** 保存一次改名（旧名 → 新名），返回 save 的结果 */
  const rename = (from: string, to: string): { success: boolean; error?: string } =>
    botService.save(from, md(to))

  it('SG-B1 会话成员名单里的旧名换成新名（其余成员原位不动）', () => {
    put('scout', md('scout'))
    seedSessions([{ id: 's1', bots: ['scout', 'ranger'] }])
    expect(rename('scout', 'pathfinder').success).toBe(true)
    expect(botsOf('s1')).toEqual(['pathfinder', 'ranger'])
  })

  it('SG-B2 不含旧名的会话一个字都不动（不该为一次改名刷一遍所有会话）', () => {
    put('scout', md('scout'))
    seedSessions([{ id: 's1', bots: ['ranger'] }, { id: 's2' }])
    rename('scout', 'pathfinder')
    expect(mocks.rewriteBots).not.toHaveBeenCalled()
  })

  it('SG-B3 名单里已经有新名字 → 去重而不是留两条', () => {
    // 用户可能先手动把新名字加进去过
    put('scout', md('scout'))
    seedSessions([{ id: 's1', bots: ['scout', 'pathfinder'] }])
    rename('scout', 'pathfinder')
    expect(botsOf('s1')).toEqual(['pathfinder'])
  })

  it('SG-B4 逐会话独立 try：一条会话写失败不挡它后面的', () => {
    // 共用一个 try 的话，第 2 条失败就让第 3..N 条全留在旧名上 —— 那会让「迁移了一半」
    // 这个本就难查的状态再多出一种形态。而「留在旧名上」的后果是 L0 门把它当成
    // 「成员 md 不存在」，也就是这个 bot 从那条会话里消失了
    put('scout', md('scout'))
    seedSessions([
      { id: 's1', bots: ['scout'] },
      { id: 's2', bots: ['scout'] },
      { id: 's3', bots: ['scout'] }
    ])
    mocks.rewriteBots.mockImplementation((id: string, bots: string[]) => {
      if (id === 's2') throw new Error('磁盘满了')
      const row = sessionRows.find((r) => r.id === id)
      if (row) row.settings.bots = bots
    })

    expect(rename('scout', 'pathfinder').success).toBe(true)
    expect(new Set(rewrittenIds())).toEqual(new Set(['s1', 's2', 's3']))
    expect(botsOf('s1')).toEqual(['pathfinder'])
    expect(botsOf('s3')).toEqual(['pathfinder'])
    // 失败的那条留在旧名上（下一次保存的补做自检会再试一次 —— 见 SG-B8）
    expect(botsOf('s2')).toEqual(['scout'])
  })

  it('SG-B5 会话列表整个读不出来也不影响其余两处迁移', () => {
    put('scout', md('scout'))
    mocks.list.mockImplementation(() => {
      throw new Error('会话库挂了')
    })
    mkdirSync(runsDir('scout'), { recursive: true })
    writeFileSync(join(runsDir('scout'), 'decisions.jsonl'), '{}\n')

    expect(rename('scout', 'pathfinder').success).toBe(true)
    expect(existsSync(runsDir('pathfinder'))).toBe(true)
  })

  it('SG-B6 决策记录与 run journal 的目录跟着改名', () => {
    // 不迁的话，这个 bot 的历史决策记录就断在改名那一刻 —— 而「它为什么没说话」
    // 恰恰是要跨着改名往回翻的那种问题
    put('scout', md('scout'))
    mkdirSync(runsDir('scout'), { recursive: true })
    writeFileSync(join(runsDir('scout'), 'decisions.jsonl'), '{"kind":"run_end"}\n')

    expect(rename('scout', 'pathfinder').success).toBe(true)
    expect(existsSync(runsDir('scout'))).toBe(false)
    expect(readFileSync(join(runsDir('pathfinder'), 'decisions.jsonl'), 'utf-8')).toContain(
      'run_end'
    )
  })

  it('SG-B6b 目标目录已存在 → 不覆盖（每一步都先看目标状态，重跑一遍不出错）', () => {
    // 新名字下已经有记录，多半是这个名字以前用过。把旧目录整个盖上去等于删掉那批记录
    put('scout', md('scout'))
    mkdirSync(runsDir('scout'), { recursive: true })
    writeFileSync(join(runsDir('scout'), 'decisions.jsonl'), '{"kind":"from-scout"}\n')
    mkdirSync(runsDir('pathfinder'), { recursive: true })
    writeFileSync(join(runsDir('pathfinder'), 'decisions.jsonl'), '{"kind":"already-there"}\n')

    expect(rename('scout', 'pathfinder').success).toBe(true)
    expect(readFileSync(join(runsDir('pathfinder'), 'decisions.jsonl'), 'utf-8')).toContain(
      'already-there'
    )
    // 旧目录也没被删 —— 什么都没做才是幂等
    expect(existsSync(runsDir('scout'))).toBe(true)
  })

  it('SG-B7 半途崩溃的补做：文件叫 scout.md 里面写着 ranger，就是一次没走完的迁移', () => {
    // 改名迁移分两步（写文件、迁三处引用），崩在中间的话之后 `name === originalName`，
    // 迁移**永不重跑**，而这个 bot 已经从所有会话里消失了。修法用上了一个事实：
    // **文件名不随改名变** —— 于是「文件叫 scout.md、里面写着 ranger」本身就是那次
    // 没走完的迁移留下的证据，补迁一次即可
    put('scout', md('ranger')) // 崩在中间的现场
    seedSessions([{ id: 's1', bots: ['scout'] }])

    // 用户对 ranger 做一次与改名毫无关系的普通保存
    expect(botService.save('ranger', md('ranger', { body: '随便改点什么' })).success).toBe(true)
    expect(botsOf('s1')).toEqual(['ranger'])
  })

  it('SG-B8 补做不误触发：旧名还对应着一个活着的 bot 就不算残留', () => {
    // `scout` 这个名字仍有一份自己的 md，那它就不是「某次改名的残留」，
    // 而是另一个真实存在的 bot —— 把会话里的 scout 改成 ranger 会是一次静默的破坏
    put('scout', md('ranger'))
    put('scout-real', md('scout'))
    seedSessions([{ id: 's1', bots: ['scout'] }])

    botService.save('ranger', md('ranger', { body: '普通保存' }))
    expect(mocks.rewriteBots).not.toHaveBeenCalled()
    expect(botsOf('s1')).toEqual(['scout'])
  })

  // 第三处引用（笔记检查点）的迁移在 botServiceNotes.test.ts 的 BN-E3：那里有一份
  // 真跑出来的检查点可搬，而这个文件里调度器从头到尾是空的 —— 在这里断言「旧名下没有
  // 残留」会恒真，是一条读起来像在测东西的空话。

  it('SG-B10 saveByFile 一个字都不迁 —— 那条通道走的是解析不出来的坏文件', () => {
    // 坏文件没有 name，也就没有「旧名」可迁；那条路的语义就是「把这份文件修好」，
    // 修好之后要不要迁由用户的下一次正经保存决定。钉住它，是因为「顺手也迁一下」
    // 看起来很对，但会让一次修文件的操作悄悄改写别处的会话名单
    put('broken', '---\nshuvix: bot v1\n这不是合法的 frontmatter')
    seedSessions([{ id: 's1', bots: ['broken'] }])

    const res = botService.saveByFile('broken.md', md('ranger'))
    expect(res.success).toBe(true)
    expect(mocks.rewriteBots).not.toHaveBeenCalled()
  })
})

// ────────────────────── SG-C：注册表变更广播（bot.changed） ──────────────────────

/**
 * 侧栏「Bots」分组靠这条信号事件重扫（列表侧从设置页搬进主窗口之后，保存 / 新建 / 删除
 * 的结果得自己长到列表上，不能等用户切一次窗口）。口径同 session.listChanged：**落盘成功
 * 才广播、不带载荷**；被守卫或校验拒绝的写入什么都没改，不该让消费者白扫一遍。
 */
describe('SG-C —— bot.changed 广播', () => {
  /** 订阅真 appEventBus，数 bot.changed 落了几次 */
  async function countChanged(run: () => void): Promise<number> {
    const { appEventBus } = await import('../../utils/appEventBus')
    let n = 0
    const off = appEventBus.subscribe((e) => {
      if (e.type === 'bot.changed') n++
    })
    try {
      run()
    } finally {
      off()
    }
    return n
  }

  it('SG-C1 五条写通道落盘成功各广播一次：save / create / delete / saveByFile / deleteByFile', async () => {
    put('scout', md('scout'))
    expect(
      await countChanged(() => {
        const r = botService.save(
          'scout',
          md('scout', { body: '改过' }),
          sourceOf('scout').revision
        )
        expect(r.success).toBe(true)
      })
    ).toBe(1)
    expect(
      await countChanged(() => {
        expect(botService.create(md('ranger')).success).toBe(true)
      })
    ).toBe(1)
    expect(
      await countChanged(() => {
        expect(botService.delete('ranger').success).toBe(true)
      })
    ).toBe(1)
    // 非法文件修好：先放一份缺 description 的，再经 saveByFile 补齐
    put('broken', ['---', 'shuvix: bot v1', 'name: broken', '---', '', 'X'].join('\n'))
    expect(
      await countChanged(() => {
        expect(botService.saveByFile('broken.md', md('broken')).success).toBe(true)
      })
    ).toBe(1)
    expect(
      await countChanged(() => {
        expect(botService.deleteByFile('broken.md').success).toBe(true)
      })
    ).toBe(1)
  })

  it('SG-C2 被拒绝的写入不广播：指纹冲突 / 非法内容 / 目标不存在', async () => {
    put('scout', md('scout'))
    const stale = sourceOf('scout').revision
    put('scout', md('scout', { notes: '外部改动' }))
    expect(
      await countChanged(() => {
        expect(botService.save('scout', md('scout', { body: '我的' }), stale).success).toBe(false)
        expect(botService.create('not a bot file').success).toBe(false)
        expect(botService.delete('ghost').success).toBe(false)
        expect(botService.deleteByFile('ghost.md').success).toBe(false)
      })
    ).toBe(0)
  })
})
