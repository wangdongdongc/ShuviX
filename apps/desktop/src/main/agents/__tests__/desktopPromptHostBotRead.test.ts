/**
 * DPH-4 —— bot 文件的「已读」与读后被改的检测，走**真的** fileTime（2026-11-06，系统提示词冻结）。
 *
 * 系统提示词冻结之后，模型手里的 bot 正文是冻结那一刻的那份：只有正文真进了提示词（冻结时的渲染），或比对出冻结的
 * 那份与文件一致（`noteSectionsCurrent(['bot_profile'])`）时才记已读。只是拿来比对的渲染（`compare`）不记 —— 用户在
 * 别处改过之后，bot 得先 `read` 到新内容才能 `edit`，读后被改的检测不会被一次比对骗过。
 *
 *   DPH-4a noteSectionsCurrent(['bot_profile']) 之后 assertNotModifiedSinceRead 通过
 *   DPH-4b 文件之后被改 → 抛「modified since it was last read」
 *   DPH-4c 一次 compare 渲染不刷新已读时间 → 仍然抛
 *   DPH-4d 再 noteSectionsCurrent（比对一致）→ 又通过
 *   DPH-4e 真渲染（不带选项）同样记已读：之后通过
 *
 * 时钟：fileTime 用 `new Date()` 记读取时间、拿文件 mtime 比（50ms 容差），所以 Date 用假时钟、mtime 用 utimes 设。
 * 只替身 botService（与 agentHost 拖进来的 electron / SQLite 那一圈，骨架照抄 desktopPromptHost.test.ts）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ forSession: vi.fn() }))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: vi.fn(), pickSettings: vi.fn() }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: vi.fn(() => []) }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: mocks.forSession } }))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: (tool: object) => tool }))

import { _resetAll, assertNotModifiedSinceRead } from '../../utils/toolUtils/fileTime'
import { desktopPromptHost } from '../agentHost'

const host = desktopPromptHost
const SID = 'bot-session-1'
const T0 = new Date('2026-11-06T09:00:00.000Z').getTime()

let root = ''
let botFile = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shuvix-dph4-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 把文件的 mtime 设到某个时刻 */
function touch(at: number): void {
  const seconds = at / 1000
  utimesSync(botFile, seconds, seconds)
}

beforeEach(() => {
  _resetAll()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  botFile = join(root, `pal-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(botFile, '---\nshuvix: bot v2\nname: pal\n---\n\nlikes tea\n')
  // 文件写在冻结之前
  touch(T0 - 60_000)
  mocks.forSession.mockReset()
  mocks.forSession.mockReturnValue({
    file: { name: 'pal', displayName: 'Pal', body: 'likes tea' },
    basePath: botFile
  })
})

afterEach(() => {
  vi.useRealTimers()
  _resetAll()
})

describe('bot 文件的已读（真 fileTime）', () => {
  it('DPH-4a..d 比对一致才记已读：之后被改 → 抛；compare 渲染不刷新；再比对一致 → 又通过', async () => {
    // 还没读过：编辑要先读
    expect(() => assertNotModifiedSinceRead(SID, botFile)).toThrow(/must read file/)

    // DPH-4a 冻结的那份与文件一致
    host.noteSectionsCurrent!(SID, ['bot_profile'])
    expect(() => assertNotModifiedSinceRead(SID, botFile)).not.toThrow()

    // DPH-4b 用户在别处改了 bot 文件
    vi.setSystemTime(T0 + 10_000)
    writeFileSync(botFile, '---\nshuvix: bot v2\nname: pal\n---\n\nlikes coffee now\n')
    touch(T0 + 10_000)
    expect(() => assertNotModifiedSinceRead(SID, botFile)).toThrow(
      /modified since it was last read/
    )

    // DPH-4c 状态比对（compare）只拿来比，不进提示词：不刷新已读时间
    vi.setSystemTime(T0 + 20_000)
    mocks.forSession.mockReturnValue({
      file: { name: 'pal', displayName: 'Pal', body: 'likes coffee now' },
      basePath: botFile
    })
    expect(await host.resolveBotContext!(SID, { compare: true })).toContain('likes coffee now')
    expect(() => assertNotModifiedSinceRead(SID, botFile)).toThrow(
      /modified since it was last read/
    )

    // DPH-4d 比对出一致（比如用户重建之后冻结的就是新正文）→ 又记一次已读
    host.noteSectionsCurrent!(SID, ['bot_profile'])
    expect(() => assertNotModifiedSinceRead(SID, botFile)).not.toThrow()
  })

  it('DPH-4 keys 里没有 bot_profile（bot 段落不一致）→ 不记已读，编辑照样要先读', () => {
    host.noteSectionsCurrent!(SID, ['project_prompt', 'knowledge_bases'])
    expect(() => assertNotModifiedSinceRead(SID, botFile)).toThrow(/must read file/)
  })

  it('DPH-4e 真渲染（冻结那一刻，不带选项）记已读：之后通过；改了之后再真渲染一次又通过', async () => {
    await host.resolveBotContext!(SID)
    expect(() => assertNotModifiedSinceRead(SID, botFile)).not.toThrow()

    vi.setSystemTime(T0 + 10_000)
    touch(T0 + 10_000)
    expect(() => assertNotModifiedSinceRead(SID, botFile)).toThrow(
      /modified since it was last read/
    )
    vi.setSystemTime(T0 + 20_000)
    await host.resolveBotContext!(SID)
    expect(() => assertNotModifiedSinceRead(SID, botFile)).not.toThrow()
  })

  it('DPH-4 已读按会话记：别的会话的比对不算这条会话读过', () => {
    host.noteSectionsCurrent!('other-session', ['bot_profile'])
    expect(() => assertNotModifiedSinceRead(SID, botFile)).toThrow(/must read file/)
    expect(() => assertNotModifiedSinceRead('other-session', botFile)).not.toThrow()
  })
})
