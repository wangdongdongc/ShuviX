/**
 * 扩展端两份基座档案（work / chat × 三语，共六份 md）里的**浏览器**说法 —— 浏览器从 multiplex
 * `browser` 工具（`action:"open_tab"` 那种调法）改成了一台内置 MCP 能力服务器（一个动作一个工具，
 * `mcp__browser__open_tab`）。这六份是共享档案的手抄副本，没有任何机制保证它们跟着改，所以钉：
 *
 *   - 工具名单里不再有裸 `browser`（扩展没有会话级勾选，内置 browser server 恒注入，不靠名单）；
 *   - 正文不再教旧调法（`action:"…"`、`"browser" tool`），而是点名 `mcp__browser__` 前缀；
 *   - 正文点名的每个浏览器工具，扩展这一端都真有（按扩展后端的能力裁过的目录）——
 *     `upload_file` / `pdf` 在扩展里不存在，一次都不许提。
 *
 * 能力取自真的扩展后端（`extensionBrowserBackend.caps`）：它的 import 图只带 `./cdp`（顶掉）与
 * 模块加载期的一次 `chrome.runtime.getURL`（桩上）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` }
  })
})
vi.mock('../cdp', () => ({ cdpManager: {} }))

import {
  buildBuiltinProfile,
  browserToolsForCaps,
  CHAT_PROFILE_NAME,
  WORK_PROFILE_NAME,
  type AgentProfile,
  type BrowserCaps
} from '@shuvix/agent-runtime'
import { createInlineMdReaderFrom } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import { extensionBrowserBackend } from '../browserBackend'

const LANGUAGES = ['en', 'zh', 'ja']
const NAMES = [WORK_PROFILE_NAME, CHAT_PROFILE_NAME]

/** 扩展自己那批 md（与 subAgent.ts / extensionBaseProfiles.test.ts 同一个 glob） */
const EXT_MD_SOURCES = import.meta.glob('../builtinAgents/md/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>
const EXT_MD = createInlineMdReaderFrom(EXT_MD_SOURCES)

const ext = (name: string, language: string): AgentProfile => {
  const built = buildBuiltinProfile({ name }, { language, readMd: EXT_MD })
  expect(built, `扩展 ${name}.${language} 应解析成合法档案`).not.toBeNull()
  return built!
}

const EVERY = NAMES.flatMap((name) => LANGUAGES.map((language) => ({ name, language })))

/** 全开的能力 = 浏览器工具的全集；扩展这一端的 = 按真后端能力裁过的 */
const ALL_CAPS: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: true
}
const ALL_TOOLS = browserToolsForCaps(ALL_CAPS).map((t) => t.name)
const EXT_TOOLS = new Set(browserToolsForCaps(extensionBrowserBackend.caps).map((t) => t.name))

/** 正文里作为整词出现（`read_page` 不算提到了 `read`：下划线是词的一部分） */
const mentions = (body: string, word: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_])${word}($|[^A-Za-z0-9_])`).test(body)

describe('扩展端基座档案 —— 浏览器是内置 MCP 能力服务器', () => {
  it('EBP-0 语料自检：六份都在；扩展确实没有 upload_file / pdf，其余浏览器工具都有', () => {
    expect(Object.keys(EXT_MD_SOURCES)).toHaveLength(6)
    expect(ALL_TOOLS).toHaveLength(22)
    expect(ALL_TOOLS.filter((t) => !EXT_TOOLS.has(t)).sort()).toEqual(['pdf', 'upload_file'])
  })

  it.each(EVERY)('EBP-1 $name.$language 的工具名单里没有裸 browser', ({ name, language }) => {
    const tools = ext(name, language).tools.map((t) => t.toLowerCase())
    expect(tools).not.toContain('browser')
    // 正控制组：名单非空（否则上面那条恒成立）
    expect(tools.length).toBeGreaterThan(0)
  })

  it.each(EVERY)(
    'EBP-2 $name.$language 正文不再教 multiplex 调法（action:"…" / "browser" tool）',
    ({ name, language }) => {
      const body = ext(name, language).systemPrompt
      expect(body).not.toContain('action:"')
      expect(body).not.toContain('"browser" tool')
    }
  )

  /**
   * 工具前缀要原样出现：prettier 曾把 `mcp__browser__*` 里的 `__x__` 改写成粗体
   * （`mcp**browser**\*`），模型于是被告知了一个不存在的前缀。扩展这份 md 目录现已在根
   * `.prettierignore` 里，正文也用反引号包住前缀；这条钉住结果，而不是钉住原因。
   */
  it.each(EVERY)(
    'EBP-3 $name.$language 正文点名 mcp__browser__ 前缀（没被改写成粗体）',
    ({ name, language }) => {
      const body = ext(name, language).systemPrompt
      expect(body).toContain('mcp__browser__')
      expect(body).not.toContain('mcp**')
    }
  )

  it.each(EVERY)(
    'EBP-4 $name.$language 正文点名的浏览器工具扩展都有；upload_file / pdf 一次都不提',
    ({ name, language }) => {
      const body = ext(name, language).systemPrompt
      const named = ALL_TOOLS.filter((tool) => mentions(body, tool))
      // 语料自检：正文确实在讲浏览器工具
      for (const expected of ['open_tab', 'list_tabs', 'read_page', 'snapshot']) {
        expect(named, expected).toContain(expected)
      }
      expect(named.filter((tool) => !EXT_TOOLS.has(tool))).toEqual([])
      expect(mentions(body, 'upload_file')).toBe(false)
      expect(mentions(body, 'pdf')).toBe(false)
    }
  )
})
