/**
 * botService —— bot 注册表（宿主层）。
 *
 * `~/.shuvix/bots/<name>.md` 纯 md 驱动：文件存在且解析得过就是活的 —— 没有启用开关、
 * 没有旁路配置、没有数据库表、也不内置任何 bot。于是这份服务只有三类职责，本文件按
 * 它们分组：
 *
 *   PSv-1…8   **扫描与解析**：目录里有什么、坏文件去哪、一条会话绑的是谁；
 *   PSv-9…19  **写盘**：内容指纹的丢更新守卫、改名迁移、原子写 —— 这一半是
 *              botServiceSaveGuard.test.ts 的近亲，因为两者面对同一个前提：
 *              **这份文件有两个写者**（用户在档案页改，bot 在答话半途用 `edit` 改自己）；
 *   PSv-20…26 **增删与非法文件通道**：新建的文件名派生、删除的边界、按文件名寻址的白名单。
 *
 * **fs 是真的** —— 指纹算的是盘上的字节、扫描扫的是真目录，换成假 fs 一条也测不到。
 * `readFileSync` / `existsSync` 只是套了一层可数的壳（同
 * instruction/__tests__/instructionInjector.test.ts 的手法）：前者给 PSv-6 造一次读失败，
 * 后者给 PSv-24 证明「白名单排在任何 fs 调用之前」。
 *
 * mock 面：sessionDao（迁移的观测点）/ 广播 / logger / electron。`appEventBus` 保持**真实** ——
 * PSv-26 数的就是真事件。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botsvc-${process.pid}`
  return { base, bots: `${base}/bots` }
})

const mocks = vi.hoisted(() => ({
  findAll: vi.fn<() => Array<{ id: string; settings?: Record<string, unknown> }>>(),
  pick: vi.fn<(id: string, cols: string[]) => unknown>(),
  updateSettings: vi.fn(),
  broadcast: vi.fn(),
  warn: vi.fn(),
  atomicWrite: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({ getDefaultBotsDir: () => dirs.bots }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    findAll: mocks.findAll,
    pick: mocks.pick,
    updateSettings: mocks.updateSettings
  }
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcast
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))
// 原子写保持真实实现（盘上得真有字节），只是外面套一层可数的壳 —— PSv-19 数它
vi.mock('../../utils/atomicWrite', () => ({ writeFileAtomic: mocks.atomicWrite }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync)
  }
})

import { botService } from '../botService'

/** 一份最小可解析的 bot md */
function md(
  name: string,
  opts: { body?: string; description?: string; displayName?: string } = {}
): string {
  const lines = ['---', 'shuvix: bot v2', `name: ${name}`]
  if (opts.description !== undefined) lines.push(`description: ${opts.description}`)
  if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
  lines.push('---', '', opts.body ?? `${name} 的人设。`)
  return lines.join('\n')
}

/** 直接往目录里放一份 `<base>.md`（文件名与 name 可以不同 —— 那正是「迁移做了一半」的形态） */
function put(fileBase: string, text: string): string {
  return putFile(`${fileBase}.md`, text)
}

/** 直接往目录里放一份文件（文件名逐字照给） */
function putFile(fileName: string, text: string): string {
  mkdirSync(dirs.bots, { recursive: true })
  const filePath = join(dirs.bots, fileName)
  writeFileSync(filePath, text)
  return filePath
}

const sourceOf = (name: string): { text: string; revision: string; path: string } =>
  botService.getSource(name)!

/** 盘上这份文件此刻的字节 */
const onDisk = (fileBase: string): string =>
  readFileSync(join(dirs.bots, `${fileBase}.md`), 'utf-8') as string

/** PSv-6 造读失败用：命中这个路径的 readFileSync 抛 EACCES */
let failReadPath: string | null = null

/** 会话表的**可变**替身：updateSettings 真写回去（迁移会连跑两趟，第二趟得看得见第一趟） */
let sessionRows: Array<{ id: string; settings: Record<string, unknown> }> = []

function seedSessions(rows: Array<{ id: string; bot?: string }>): void {
  sessionRows = rows.map((r) => ({ id: r.id, settings: r.bot ? { bot: r.bot } : {} }))
}

const boundBotOfSession = (id: string): unknown =>
  sessionRows.find((r) => r.id === id)?.settings.bot

/** updateSettings 收到过的会话 id（按调用序） */
const rewrittenIds = (): string[] => mocks.updateSettings.mock.calls.map((c) => String(c[0]))

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

beforeAll(async () => {
  const realFs = await vi.importActual<typeof import('fs')>('fs')
  const realAtomic =
    await vi.importActual<typeof import('../../utils/atomicWrite')>('../../utils/atomicWrite')
  // 实现装一次、之后只 mockClear（mockReset 会把实现一起抹掉）
  vi.mocked(readFileSync).mockImplementation(((p: string, ...rest: unknown[]) => {
    if (failReadPath !== null && String(p) === failReadPath) {
      throw new Error('EACCES: permission denied')
    }
    return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as never)
  vi.mocked(existsSync).mockImplementation(realFs.existsSync)
  mocks.atomicWrite.mockImplementation(realAtomic.writeFileAtomic)
})

beforeEach(() => {
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.bots, { recursive: true })
  failReadPath = null
  for (const m of Object.values(mocks)) m.mockClear()
  vi.mocked(readFileSync).mockClear()
  vi.mocked(existsSync).mockClear()
  sessionRows = []
  mocks.findAll.mockImplementation(() => sessionRows)
  mocks.updateSettings.mockImplementation((id: string, patch: { bot: string }) => {
    const row = sessionRows.find((r) => r.id === id)
    if (row) row.settings.bot = patch.bot
  })
  mocks.pick.mockReturnValue(undefined)
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

// ────────────────────── PSv-1…8：扫描与解析 ──────────────────────

describe('PSv-1…8 —— 扫描、解析与「这条会话绑的是谁」', () => {
  it('PSv-1 只扫非点开头的 *.md，跳过目录（后缀大小写不敏感）', () => {
    // 目录被算进来会让整个扫描在 readFileSync(EISDIR) 上抛；点文件是编辑器的临时残留
    // （`.scout.md.swp` 那一族），把它们当 bot 会让列表里凭空多出几个半截 bot
    put('scout', md('scout'))
    put('.hidden', md('hidden'))
    putFile('notes.txt', md('notes'))
    mkdirSync(join(dirs.bots, 'looks-like.md'))
    // `.toLowerCase().endsWith('.md')` —— Windows / macOS 上的 .MD 是同一种文件
    putFile('LOUD.MD', md('loud'))

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid.map((p) => p.file.name).sort()).toEqual(['loud', 'scout'])
    expect(invalid).toEqual([])
  })

  it('PSv-2 解析不过的文件进 invalid 并带解析器理由，绝不进 valid', () => {
    // invalid 那一拨是档案页「修一下」的入口：理由就是横幅上的文案，丢了它用户只看到
    // 一个打不开的文件名。更要紧的是**绝不进 valid** —— 半解析的 bot 会被注入
    put('scout', md('scout'))
    put('broken', '这根本不是一份 md')
    put('badyaml', '---\n[unclosed\n---\nbody')

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid.map((p) => p.file.name)).toEqual(['scout'])
    expect(invalid.map((f) => f.fileName).sort()).toEqual(['badyaml.md', 'broken.md'])
    expect(invalid.find((f) => f.fileName === 'broken.md')!.error).toContain(
      'no YAML frontmatter block'
    )
    expect(invalid.find((f) => f.fileName === 'badyaml.md')!.error).toContain('invalid YAML')
  })

  it('PSv-3 一份 agent md 掉进 bots 目录落在 invalid', () => {
    // 解析层那条整份拒绝（botFile 的 PR-4）在服务层的对偶。放行的后果不是「多一个
    // 条目」，而是那份工程提示词被当作某人的人设贴进根 Agent 的系统提示词
    put(
      'coder',
      ['---', 'shuvix: agent v1', 'name: coder', '---', '', 'You write code.'].join('\n')
    )
    const { valid, invalid } = botService.listWithInvalid()
    expect(valid).toEqual([])
    expect(invalid).toHaveLength(1)
    expect(invalid[0].error).toContain('is not a bot file')
  })

  it('PSv-4 同名两份文件：先到者胜，后者静默跳过且不报 invalid', () => {
    // 身份是 frontmatter 的 `name`，而文件名可以任意 —— 两份文件写同一个名字是做得到的。
    // 现状是**静默丢弃**：第二份既不在 valid 里、也不在 invalid 里，用户在档案页上
    // 完全看不见它，只有日志里有一句。钉住它，是因为这是唯一能发现这个行为的地方
    put('a-scout', md('scout', { body: '第一份' }))
    put('z-scout', md('scout', { body: '第二份' }))

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid).toHaveLength(1)
    expect(invalid).toEqual([])
    // 胜者是目录枚举序里靠前的那个（服务与本用例看到的是同一次枚举）
    const first = readdirSync(dirs.bots).filter((n) => n.endsWith('.md'))[0]
    expect(valid[0].basePath).toBe(join(dirs.bots, first))
    // 丢弃只在日志里留痕
    expect(mocks.warn.mock.calls.flat().join(' ')).toContain('重复')
  })

  it('PSv-5 目录不存在 → 空清单、不抛，且不创建目录', () => {
    // 首次启动时这个目录不存在。顺手 mkdir 会在用户还没建过任何 bot 时就往 ~/.shuvix
    // 里撒一个空目录 —— 纯 md 驱动的纪律是「用户建了才有」
    rmSync(dirs.bots, { recursive: true, force: true })
    expect(() => botService.listWithInvalid()).not.toThrow()
    expect(botService.listWithInvalid()).toEqual({ valid: [], invalid: [] })
    expect(botService.listAll()).toEqual([])
    expect(existsSync(dirs.bots)).toBe(false)
  })

  it('PSv-6 读某个文件抛错 → 该条进 invalid，扫描继续', () => {
    // 一份读不动的文件（权限 / 正在被别的进程重写）不该让整个列表变空 —— 侧栏会显示
    // 「一个 bot 都没有」，而用户只是有一份文件出了问题
    put('scout', md('scout'))
    failReadPath = put('locked', md('locked'))

    const { valid, invalid } = botService.listWithInvalid()
    expect(valid.map((p) => p.file.name)).toEqual(['scout'])
    expect(invalid).toHaveLength(1)
    expect(invalid[0].fileName).toBe('locked.md')
    expect(invalid[0].error).toContain('EACCES')
  })

  it('PSv-7 get 按 frontmatter name 匹配而非文件名', () => {
    // 改名只改 frontmatter，文件名不动（迁移的补做就建立在这个事实上，见 PSv-18）——
    // 于是两者永久分叉，按文件名找会在第一次改名之后全线失效
    put('scout', md('ranger'))
    expect(botService.get('ranger')?.basePath).toBe(join(dirs.bots, 'scout.md'))
    expect(botService.get('scout')).toBeNull()
  })

  it('PSv-8 forSession：绑定 → 条目；非 bot 会话 → null；md 已被删 → null + warn，不抛', () => {
    // 注入侧的唯一入口。**绑定不存在不该让会话打不开** —— 那是用户删了一个文件，
    // 不是数据损坏；会话照常跑在基座 bot 上，只是没有人设可注入（AG-3 是它的对偶）
    put('scout', md('scout'))

    mocks.pick.mockReturnValue({ settings: { bot: 'scout' } })
    expect(botService.forSession('s1')?.file.name).toBe('scout')
    expect(mocks.warn).not.toHaveBeenCalled()

    for (const settings of [undefined, {}, { bot: '' }, { bot: '  ' }, { bots: ['old'] }]) {
      mocks.pick.mockReturnValue({ settings })
      expect(botService.forSession('s1'), JSON.stringify(settings)).toBeNull()
    }
    // 会话行整个不存在（刚被删）同样只是 null
    mocks.pick.mockReturnValue(undefined)
    expect(botService.forSession('ghost')).toBeNull()
    expect(mocks.warn).not.toHaveBeenCalled()

    mocks.pick.mockReturnValue({ settings: { bot: 'gone' } })
    expect(() => botService.forSession('s1')).not.toThrow()
    expect(botService.forSession('s1')).toBeNull()
    expect(mocks.warn.mock.calls.flat().join(' ')).toContain('gone')
  })
})

// ────────────────────── PSv-9…19：写盘（丢更新守卫 + 改名迁移） ──────────────────────

/**
 * 守的是这条时序：**T0 用户在档案页打开 → T1 bot 在答话半途 `edit` 了这份文件 →
 * T2 用户按保存**。没有守卫的话 T2 会把 T1 记下的东西静默吃掉 —— `edit` 工具自带的
 * 「读后被改」检测保护的是 agent 那一侧，反方向从来没有人守。
 */
describe('PSv-9…14 —— 内容指纹（丢更新守卫）', () => {
  it('PSv-9 getSource 回原文 + 内容哈希（不是 mtime）+ 路径；同字节同 revision', () => {
    // 用 mtime 会漏掉最该拦的那一种：bot 的写入与用户的保存可以落在同一秒里，
    // 而 mtime 的分辨率恰好把这种情况判成「没变」
    const path = put('scout', md('scout'))
    const got = sourceOf('scout')
    expect(got.text).toBe(onDisk('scout'))
    expect(got.path).toBe(path)
    expect(got.revision).toMatch(/^[0-9a-f]{40}$/)

    put('scout', md('scout'))
    expect(sourceOf('scout').revision).toBe(got.revision)
    put('scout', md('scout', { body: '多了一句' }))
    expect(sourceOf('scout').revision).not.toBe(got.revision)

    expect(botService.getSource('ghost')).toBeNull()
  })

  it('PSv-10 revision 相符 → 保存成功并回**新** revision', () => {
    // 回新指纹是为了让 UI 能接着存第二次 —— 否则第二次必然拿着过期的指纹误报冲突
    put('scout', md('scout'))
    const next = md('scout', { body: '改过的正文。' })
    const res = botService.save('scout', next, sourceOf('scout').revision)
    expect(res.success).toBe(true)
    expect(onDisk('scout')).toBe(next)
    expect(res.revision).toBe(sourceOf('scout').revision)

    // 连存两次：第二次拿第一次回的指纹，仍然成功
    const second = botService.save('scout', md('scout', { body: '第二改' }), res.revision)
    expect(second.success).toBe(true)
    expect(onDisk('scout')).toContain('第二改')
  })

  it('PSv-11 revision 不符 → 拒绝，conflict.current 带**磁盘上的原始字节**', () => {
    // 这正是本特性真实存在的双写者场景。UI 拿 current 做三方合并，所以它必须逐字节等于
    // 盘上那一份 —— 任何一次「解析再吐出来」都会顺手规整掉空行与键序，用户看到的差异里
    // 就会混进一堆不是 bot 改的东西
    put('scout', md('scout'))
    const stale = sourceOf('scout').revision
    const messy = `${md('scout', { body: '## 偏好\n\n- 简答   ' })}\n\n\n`
    put('scout', messy)

    const res = botService.save('scout', md('scout', { body: '用户这边的改动' }), stale)
    expect(res.success).toBe(false)
    expect(res.conflict?.current).toBe(messy)
    expect(res.error).toContain('changed on disk')
    // 拒绝是真的没写
    expect(onDisk('scout')).toBe(messy)
  })

  it('PSv-12 省略 revision → 直接覆盖（坏文件的修复通道没有可对照的版本）', () => {
    put('scout', md('scout'))
    const next = md('scout', { body: '直接覆盖' })
    expect(botService.save('scout', next).success).toBe(true)
    expect(onDisk('scout')).toBe(next)
  })

  /**
   * **空串不是「没传」。** 判据必须是 `revision !== undefined` 而不是真值判断：真值判断会
   * 让 `revision: ''` 掉进「没传」那一支，**整道丢更新守卫被跳过、静默覆盖**掉 bot 刚记下的
   * 东西。前端凡是「先拿指纹、再回传」的写法，指纹没拿到时最自然的占位就是空串。
   * botService 那一侧写对了（SG-A6），这份近亲一度抄漏。
   */
  it('PSv-12b revision 为空串 → 算不符而不是没传（守卫不得被跳过）', () => {
    put('scout', md('scout'))
    const res = botService.save('scout', md('scout', { body: '覆盖' }), '')
    expect(res.success).toBe(false)
    expect(res.conflict).toBeDefined()
    expect(onDisk('scout')).toBe(md('scout'))
  })

  it('PSv-13 revision 检查排在解析之前 —— 冲突的文件不该先被挑语法毛病', () => {
    // 顺序反过来的话，用户拿到的是「你的 md 有语法错」，而真正发生的是「有人改了这份文件」
    put('scout', md('scout'))
    const stale = sourceOf('scout').revision
    put('scout', md('scout', { body: 'bot 改的' }))

    const res = botService.save('scout', '这根本不是一份合法的 md', stale)
    expect(res.success).toBe(false)
    expect(res.conflict).toBeDefined()
    expect(res.error).toContain('changed on disk')
  })

  it('PSv-14 文本非法 → 拒绝，且磁盘文件逐字节未变', () => {
    put('scout', md('scout'))
    const before = onDisk('scout')
    const res = botService.save('scout', '---\n[unclosed\n---\nbody')
    expect(res.success).toBe(false)
    expect(res.error).toContain('invalid YAML')
    expect(onDisk('scout')).toBe(before)
    expect(mocks.atomicWrite).not.toHaveBeenCalled()

    // 名字不存在 → 报找不到（守卫之前先得有这个 bot）
    expect(botService.save('ghost', md('ghost'))).toEqual({
      success: false,
      error: 'Bot "ghost" not found'
    })
  })
})

/**
 * bot 的身份是 frontmatter 的 `name`，而会话的 `settings.bot` 引用它。不迁的话，
 * 改一次名等于把这个 bot 从它**所有**的会话里抽走，而用户看到的只是「我改了个名字」。
 */
describe('PSv-15…18 —— 改名迁移', () => {
  const rename = (from: string, to: string): { success: boolean; error?: string } =>
    botService.save(from, md(to))

  it('PSv-15 改名撞上另一个 bot 已占的名字 → 拒绝', () => {
    // 允许撞名就等于把两个 bot 合并成一个：扫描时先到者胜，另一份连同它的会话一起
    // 从列表里消失（PSv-4 的静默丢弃）
    put('scout', md('scout'))
    put('ranger', md('ranger'))
    const res = rename('scout', 'ranger')
    expect(res.success).toBe(false)
    expect(res.error).toContain('already exists')
    // 两份文件都没动
    expect(onDisk('scout')).toContain('name: scout')
    expect(onDisk('ranger')).toContain('name: ranger')
  })

  it('PSv-16 改名迁移每一条绑定会话；无关会话一次都不写', () => {
    put('scout', md('scout'))
    seedSessions([
      { id: 's1', bot: 'scout' },
      { id: 's2', bot: 'ranger' },
      { id: 's3' },
      { id: 's4', bot: 'scout' }
    ])
    expect(rename('scout', 'pathfinder').success).toBe(true)

    expect(boundBotOfSession('s1')).toBe('pathfinder')
    expect(boundBotOfSession('s4')).toBe('pathfinder')
    // 不该为一次改名刷一遍所有会话
    expect(new Set(rewrittenIds())).toEqual(new Set(['s1', 's4']))
    expect(boundBotOfSession('s2')).toBe('ranger')
    expect(boundBotOfSession('s3')).toBeUndefined()
    // 每条迁过的会话都广播一次配置变更（开着的那条会话要立刻看到新名字）
    expect(new Set(mocks.broadcast.mock.calls.map((c) => String(c[0])))).toEqual(
      new Set(['s1', 's4'])
    )
  })

  it('PSv-17 某条会话写失败不影响其余；findAll 抛错也不让保存失败', () => {
    // 共用一个 try 的话，第 2 条失败就让第 3..N 条全留在旧名上 —— 而「留在旧名上」的
    // 后果是那个 bot 从那条会话里消失了（forSession → null，会话变成没有人设的裸会话）
    put('scout', md('scout'))
    seedSessions([
      { id: 's1', bot: 'scout' },
      { id: 's2', bot: 'scout' },
      { id: 's3', bot: 'scout' }
    ])
    mocks.updateSettings.mockImplementation((id: string, patch: { bot: string }) => {
      if (id === 's2') throw new Error('磁盘满了')
      const row = sessionRows.find((r) => r.id === id)
      if (row) row.settings.bot = patch.bot
    })
    expect(rename('scout', 'pathfinder').success).toBe(true)
    expect(new Set(rewrittenIds())).toEqual(new Set(['s1', 's2', 's3']))
    expect(boundBotOfSession('s1')).toBe('pathfinder')
    expect(boundBotOfSession('s3')).toBe('pathfinder')
    expect(boundBotOfSession('s2')).toBe('scout')

    // 会话库整个读不出来：文件照样保存成功（迁移是尽力而为，不是保存的前置条件）
    rmSync(dirs.base, { recursive: true, force: true })
    put('lonely', md('lonely'))
    mocks.findAll.mockImplementation(() => {
      throw new Error('会话库挂了')
    })
    expect(rename('lonely', 'renamed').success).toBe(true)
    expect(onDisk('lonely')).toContain('name: renamed')
  })

  it('PSv-18 半途崩溃的补做：文件叫 scout.md 而里面写着 ranger 时下次保存补迁', () => {
    // 改名迁移分两步（写文件、迁会话绑定），崩在中间之后 `name === originalName`，迁移
    // **永不重跑**，而这个 bot 已经从所有会话里消失了。修法用上了一个事实：
    // **文件名不随改名变** —— 「文件叫 scout.md、里面写着 ranger」本身就是那次没走完的
    // 迁移留下的证据。幂等：正常保存时这一步什么都不做
    put('scout', md('ranger')) // 崩在中间的现场
    seedSessions([{ id: 's1', bot: 'scout' }])
    expect(botService.save('ranger', md('ranger', { body: '随便改点什么' })).success).toBe(true)
    expect(boundBotOfSession('s1')).toBe('ranger')

    // 不误触发：`scout` 这个名字仍有一份自己的活 md，那它就不是残留而是另一个真 bot
    rmSync(dirs.base, { recursive: true, force: true })
    mocks.updateSettings.mockClear()
    put('scout', md('ranger'))
    put('scout-real', md('scout'))
    seedSessions([{ id: 's1', bot: 'scout' }])
    botService.save('ranger', md('ranger', { body: '普通保存' }))
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('scout')
  })
})

describe('PSv-19 —— 所有写路径都经 writeFileAtomic', () => {
  it('save / create / saveByFile 一律原子写（半份文件会让 bot 从列表里消失一瞬）', () => {
    // bot 会在答话途中用 `edit` 改自己这份文件，而 scanDir 随时可能在读。`writeFileSync`
    // 默认 'w' 先截断再写 —— 读者会看到半份文件，于是这个 bot 短暂地变成一条 invalid
    put('scout', md('scout'))
    botService.save('scout', md('scout', { body: 'A' }))
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(1)

    botService.create(md('ranger'))
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(2)

    put('broken', '不是 md')
    botService.saveByFile('broken.md', md('fixed'))
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(3)
    // 三次写的目标都在 bots 目录里
    for (const [path] of mocks.atomicWrite.mock.calls) {
      expect(String(path).startsWith(dirs.bots)).toBe(true)
    }
  })
})

// ────────────────────── PSv-20…26：新建、删除、按文件名寻址 ──────────────────────

describe('PSv-20…23 —— 新建与删除', () => {
  it('PSv-20 create 由名字派生文件名并净化，目录不存在时创建，撞名以 -1/-2 去重', () => {
    // 名字是用户随手取的，可能带路径分隔符与 Windows 保留字符 —— 不净化就是一次目录穿越。
    // 去重则是因为**身份是名字、文件名只是容器**：两个不同的名字可以净化成同一个基名
    rmSync(dirs.bots, { recursive: true, force: true })
    expect(botService.create(md("'a/b\\c:d*e?f\"g<h>i|j'")).success).toBe(true)
    expect(existsSync(join(dirs.bots, 'a-b-c-d-e-f-g-h-i-j.md'))).toBe(true)

    // 前导点剥掉（点文件不会被扫描到 —— 建出来就等于建了个隐形 bot）；剥干净了兜底为 bot
    expect(botService.create(md("'..evil'")).success).toBe(true)
    expect(existsSync(join(dirs.bots, 'evil.md'))).toBe(true)
    expect(botService.create(md("'...'")).success).toBe(true)
    expect(existsSync(join(dirs.bots, 'bot.md'))).toBe(true)

    // 三个不同的名字净化成同一个基名 → x-y.md / x-y-1.md / x-y-2.md
    for (const name of ["'x:y'", "'x*y'", "'x?y'"]) {
      expect(botService.create(md(name)).success, name).toBe(true)
    }
    for (const file of ['x-y.md', 'x-y-1.md', 'x-y-2.md']) {
      expect(existsSync(join(dirs.bots, file)), file).toBe(true)
    }
    // 六个不同的名字、六份文件 —— 一份都没被覆盖掉
    expect(botService.listAll()).toHaveLength(6)
  })

  it('PSv-21 create 拒绝重复的 frontmatter 名字，哪怕文件名没被占用', () => {
    // 身份是名字。放行会得到两份同名文件，而扫描只认先到的那一份（PSv-4）——
    // 用户会看到「新建成功」然后列表里什么都没多
    put('some-file', md('scout'))
    const res = botService.create(md('scout'))
    expect(res.success).toBe(false)
    expect(res.error).toContain('already exists')
    expect(existsSync(join(dirs.bots, 'scout.md'))).toBe(false)

    // 文本本身非法同样拒绝（先解析，后建文件）
    expect(botService.create('不是 md').success).toBe(false)
    expect(readdirSync(dirs.bots)).toEqual(['some-file.md'])
  })

  it('PSv-22 newBotTemplate 的产物解析得回、带标记、且正文**非空**', () => {
    // 正文非空是**机制要求**，不是装饰：bot 靠 `edit` 维护自己这份文件，而 `edit` 需要
    // 一段能锚定的既有文本 —— 空正文里它无处下手，于是这个 bot 永远学不会第一件事
    const text = botService.newBotTemplate({ name: 'scout' })
    expect(text.split('\n')[1]).toBe('shuvix: bot v2')

    expect(botService.create(text).success).toBe(true)
    const entry = botService.get('scout')!
    expect(entry.file.name).toBe('scout')
    expect(entry.file.displayName).toBe('scout')
    expect(entry.file.description.length).toBeGreaterThan(0)
    expect(entry.file.body.trim().length).toBeGreaterThan(0)

    // 调用方给的正文与描述压过骨架
    const custom = botService.newBotTemplate({
      name: 'r',
      body: '我的人设',
      description: 'd'
    })
    expect(botService.create(custom).success).toBe(true)
    expect(botService.get('r')!.file.body).toBe('我的人设')
    expect(botService.get('r')!.file.description).toBe('d')
  })

  it('PSv-23 delete 删文件，绑定它的会话原封不动', () => {
    // 会话是用户资产：删一个 md 不该带走对话。那条会话照常打开、照常跑在基座 bot 上，
    // 只是没有人设可注入（forSession → null + warn，见 PSv-8）
    put('scout', md('scout'))
    seedSessions([{ id: 's1', bot: 'scout' }])

    expect(botService.delete('scout')).toEqual({ success: true })
    expect(existsSync(join(dirs.bots, 'scout.md'))).toBe(false)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('scout')

    expect(botService.delete('scout')).toEqual({
      success: false,
      error: 'Bot "scout" not found'
    })
  })
})

describe('PSv-24…25 —— 按文件名寻址的通道（非法文件的修复入口）', () => {
  it('PSv-24 文件名白名单：路径穿越 / 非 .md / 点文件一律拒绝，且不碰文件系统', () => {
    // fileName 来自渲染进程。虽然今天只由 listWithInvalid 的返回值填充，仍按不可信入参
    // 处理 —— 这条通道会**读、写、删**它指到的文件
    const outside = join(dirs.base, 'outside.md')
    mkdirSync(join(dirs.bots, 'sub'), { recursive: true })
    writeFileSync(outside, md('outside'))
    writeFileSync(join(dirs.bots, 'sub', 'x.md'), md('nested'))

    vi.mocked(readFileSync).mockClear()
    vi.mocked(existsSync).mockClear()
    const bad = [
      '../outside.md',
      '../../.ssh/id_rsa',
      'sub/dir/x.md',
      'sub/x.md',
      '..\\outside.md',
      'x.txt',
      'x',
      '.hidden.md'
    ]
    for (const fileName of bad) {
      expect(botService.getSourceByFile(fileName), fileName).toBeNull()
      expect(botService.saveByFile(fileName, md('x')).success, fileName).toBe(false)
      expect(botService.deleteByFile(fileName).success, fileName).toBe(false)
    }
    // 白名单排在**任何** fs 调用之前 —— 连 existsSync 都没跑过一次
    expect(existsSync).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(mocks.atomicWrite).not.toHaveBeenCalled()
    expect(readFileSync(outside, 'utf-8')).toBe(md('outside'))

    // 正控制组：目录里一个真实存在的 .md 文件名是过得去的
    put('broken', '不是 md')
    expect(botService.getSourceByFile('broken.md')?.text).toBe('不是 md')
    // 不存在的合法文件名 → null（白名单过了，existsSync 没过）
    expect(botService.getSourceByFile('nope.md')).toBeNull()
  })

  it('PSv-25 saveByFile 不跑改名迁移，但仍拒绝非法文本', () => {
    // 坏文件没有 name，也就没有「旧名」可迁；那条路的语义就是「把这份文件修好」。
    // 「顺手也迁一下」看起来很对，却会让一次修文件的操作悄悄改写别处的会话绑定
    put('broken', '---\nshuvix: bot v1\n这不是合法的 frontmatter')
    seedSessions([{ id: 's1', bot: 'broken' }])

    const res = botService.saveByFile('broken.md', md('ranger'))
    expect(res.success).toBe(true)
    expect(res.name).toBe('ranger')
    expect(res.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(boundBotOfSession('s1')).toBe('broken')

    // 修坏了照样拒绝，盘上还是刚才那一份
    const before = onDisk('broken')
    expect(botService.saveByFile('broken.md', '还是不合法').success).toBe(false)
    expect(onDisk('broken')).toBe(before)

    // deleteByFile 清掉一个修不好的文件
    expect(botService.deleteByFile('broken.md')).toEqual({ success: true })
    expect(existsSync(join(dirs.bots, 'broken.md'))).toBe(false)
  })
})

describe('PSv-26 —— bot.changed 广播', () => {
  it('五条写通道成功各广播一次；被拒的写一次都不发', async () => {
    // 侧栏「Bots」分组靠这条信号重扫。口径同 bot.changed：**落盘成功才广播、不带载荷** ——
    // 被守卫或校验拒绝的写入什么都没改，不该让消费者白扫一遍
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
    put('broken', '不是 md')
    expect(
      await countChanged(() => {
        expect(botService.saveByFile('broken.md', md('fixed')).success).toBe(true)
      })
    ).toBe(1)
    expect(
      await countChanged(() => {
        expect(botService.deleteByFile('broken.md').success).toBe(true)
      })
    ).toBe(1)

    // 被拒的四种：指纹冲突 / 非法内容 / 目标不存在 / 文件名不合白名单
    const stale = sourceOf('scout').revision
    put('scout', md('scout', { body: '外部改动' }))
    expect(
      await countChanged(() => {
        expect(botService.save('scout', md('scout', { body: '我的' }), stale).success).toBe(false)
        expect(botService.create('not a bot file').success).toBe(false)
        expect(botService.delete('ghost').success).toBe(false)
        expect(botService.deleteByFile('../x.md').success).toBe(false)
      })
    ).toBe(0)
  })
})
