// @vitest-environment jsdom
/**
 * 两个本地命令工具在对话流里的样子（jsdom）—— `bash`（macOS / Linux）与 `powershell`（Windows）
 * 是同一条执行路径、同一种 details，界面上也该是同一个样子，只差语法着色：
 *
 *   - F3 询问卡片：powershell 发起的命令按 PowerShell 着色，其余（bash、ssh exec）按 shell 着色；
 *     命令文本经高亮器转义，不会被当成 HTML；
 *   - F4 工具卡的终端形态：同样的 details（cwd / exitCode / background）画出同样的提示符位置、
 *     退出码标记与后台标签 —— 判别收在 isShellCommandDetails / isBackgroundCall，不再只认 'bash'；
 *   - F6 提示符里的 cwd：Windows 路径（`C:\Users\<name>\…`）同样折成 `~`，缩短时保留反斜杠。
 *
 * 包入口 `@shuvix/chat-ui` 整个顶掉（AskForm 从入口取 getHostApi —— 同 builtinMcpRows.dom.test.tsx）。
 * i18n 走真 zh 资源。文件是 .tsx 但不写 JSX，一律 createElement（与同目录其它 DOM 用例一致）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AskInputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore } from '../../../stores/chatStore'
import { ToolCallBlock } from '../ToolCallBlock'
import { TerminalView } from '../TerminalView'
import { AskForm } from '../inputs/AskForm'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(element: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(element)
  })
}

/** 宿主呈现表里的两个命令工具（与桌面注册项同形：终端形态详情） */
const TERMINAL: ToolPresentation = {
  label: 'Run Command',
  icon: 'Terminal',
  detailView: 'terminal'
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  useChatStore.setState({
    toolPresentations: { bash: TERMINAL, powershell: TERMINAL },
    activeSessionId: null,
    sessionToolExecutions: {},
    sessionPendingInputs: {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

/** 终端形态的提示符行：`[位置] ❯ 命令 [exit N]`（没有终端形态 → null） */
function terminalPrompt(): HTMLElement | null {
  const caret = [...container.querySelectorAll('span')].find((s) => s.textContent === '❯')
  return caret?.parentElement ?? null
}
/** 提示符行里的位置 —— 带 title 的那个 span；没有 → null */
function terminalLocation(): { text: string; title: string } | null {
  const loc = terminalPrompt()?.querySelector<HTMLElement>('span[title]')
  return loc ? { text: loc.textContent ?? '', title: loc.getAttribute('title') ?? '' } : null
}
/** 提示符行尾的退出码标记（`exit N`）；没有 → null */
function exitMarker(): string | null {
  const spans = [...(terminalPrompt()?.querySelectorAll('span') ?? [])]
  return spans.find((s) => /^exit /.test(s.textContent ?? ''))?.textContent ?? null
}

// ─── F3：询问卡片的着色 ──────────────────────────────────────────────────────

describe('AskForm — 命令询问按发起它的工具着色', () => {
  const renderAsk = (toolName: string, command: string): void => {
    const request: AskInputRequest = {
      id: 'tc-1',
      kind: 'ask',
      toolName,
      command,
      description: 'Run it',
      createdAt: 0
    }
    render(
      createElement(AskForm, {
        request,
        draft: {},
        onDraftChange: vi.fn(),
        onSubmit: vi.fn()
      })
    )
  }
  const codeBlock = (): HTMLElement => {
    const code = container.querySelector<HTMLElement>('code.hljs')
    if (!code) throw new Error('command preview not rendered')
    return code
  }

  it('F3 — powershell：code.hljs.language-powershell（而不是 bash）', () => {
    renderAsk(
      'powershell',
      "Get-ChildItem $env:USERPROFILE | Where-Object { $_.Name -like '*.log' }"
    )
    const code = codeBlock()
    expect(code.classList.contains('language-powershell')).toBe(true)
    expect(code.classList.contains('language-bash')).toBe(false)
    expect(code.textContent).toContain('Get-ChildItem $env:USERPROFILE')
  })

  it.each(['bash', 'mcp__ssh__exec'])('F3 — %s：仍按 shell 着色（language-bash）', (toolName) => {
    renderAsk(toolName, 'ls -la | grep x')
    const code = codeBlock()
    expect(code.classList.contains('language-bash')).toBe(true)
    expect(code.classList.contains('language-powershell')).toBe(false)
  })

  it.each(['powershell', 'bash'])(
    'F3 — %s：命令里的 <b>x</b> 是文字，不是元素（高亮器输出经转义才进 innerHTML）',
    (toolName) => {
      renderAsk(toolName, 'Write-Output "<b>x</b>"')
      const code = codeBlock()
      expect(code.querySelector('b')).toBeNull()
      expect(code.textContent).toContain('<b>x</b>')
    }
  )
})

// ─── F4：工具卡的终端形态 ────────────────────────────────────────────────────

describe('ToolCallBlock — bash 与 powershell 画成同一个终端', () => {
  type Shell = 'bash' | 'powershell'

  const toolRow = (name: string): HTMLElement => {
    const el = container.querySelector<HTMLElement>(`[data-tool-name="${name}"]`)
    if (!el) throw new Error(`tool row ${name} not rendered`)
    return el
  }
  const expand = (row: HTMLElement): void => {
    act(() => {
      ;(row.querySelector('button') as HTMLButtonElement).click()
    })
  }

  /** 渲染一张完成了的命令卡并展开，交回终端形态里能看到的东西 */
  function terminalOf(
    shell: Shell,
    extra: object = {}
  ): {
    location: { text: string; title: string } | null
    exit: string | null
    output: string[]
  } {
    const details = {
      type: shell,
      exitCode: 2,
      truncated: false,
      cwd: '/w/proj',
      ...extra
    } as ToolResultDetails
    render(
      createElement(ToolCallBlock, {
        toolName: shell,
        args: { command: 'build-it', description: 'Build' },
        result: 'failed: 1 error',
        details,
        status: 'done'
      })
    )
    const row = toolRow(shell)
    expand(row)
    expect(terminalPrompt(), `${shell} 应当是终端形态`).not.toBeNull()
    return {
      location: terminalLocation(),
      exit: exitMarker(),
      output: [...row.querySelectorAll('pre')].map((p) => p.textContent ?? '')
    }
  }

  it('F4 — 同样的 details（cwd /w/proj、exitCode 2）：提示符位置与退出码标记一模一样', () => {
    const bash = terminalOf('bash')
    act(() => root.unmount())
    root = createRoot(container)
    const ps = terminalOf('powershell')

    expect(bash.location).toEqual({ text: '/w/proj', title: '/w/proj' })
    expect(bash.exit).toBe('exit 2')
    expect(bash.output).toContain('failed: 1 error')
    expect(ps).toEqual(bash)
  })

  it.each(['bash', 'powershell'] as const)('F4 — %s 带 background：摘要行上有后台标签', (shell) => {
    render(
      createElement(ToolCallBlock, {
        toolName: shell,
        args: { command: 'npm run dev', description: 'Dev server', run_in_background: true },
        result: 'Background task started, pid 7',
        details: {
          type: shell,
          exitCode: 0,
          truncated: false,
          cwd: '/w',
          background: true
        } as ToolResultDetails,
        status: 'done'
      })
    )
    const tag = i18n.t('toolCall.backgroundTag')
    expect(tag).not.toBe('toolCall.backgroundTag')
    expect(toolRow(shell).textContent).toContain(tag)
  })

  it.each(['bash', 'powershell'] as const)('F4 — %s 不带 background：没有后台标签', (shell) => {
    render(
      createElement(ToolCallBlock, {
        toolName: shell,
        args: { command: 'ls', description: 'List' },
        result: 'a',
        details: { type: shell, exitCode: 0, truncated: false, cwd: '/w' } as ToolResultDetails,
        status: 'done'
      })
    )
    expect(toolRow(shell).textContent).not.toContain(i18n.t('toolCall.backgroundTag'))
  })
})

// ─── F6：提示符里的 cwd ──────────────────────────────────────────────────────

describe('TerminalView — 提示符里的 cwd 怎么缩', () => {
  const locationFor = (cwd: string): { text: string; title: string } | null => {
    render(createElement(TerminalView, { command: 'ls', cwd }))
    return terminalLocation()
  }

  it.each([
    // Windows：家目录折成 ~，大小写不敏感，保留反斜杠
    ['C:\\Users\\alice\\proj', '~\\proj'],
    ['c:\\users\\Alice', '~'],
    ['C:\\Users\\alice\\projects\\some-very-long-directory\\seg1\\seg2', '…\\seg1\\seg2'],
    ['D:\\work\\a-rather-long-folder-name\\nested\\seg1\\seg2', '…\\seg1\\seg2'],
    ['D:\\work\\x', 'D:\\work\\x'],
    // POSIX：原有行为不变
    ['/Users/bob/code', '~/code'],
    ['/home/bob', '~'],
    ['/Users/bob/projects/very-long-directory-name/a/b', '…/a/b'],
    ['/opt/some/really/long/path/that/goes/on/a/b', '…/a/b']
  ])('F6 — %s → %s（title 仍是完整路径）', (cwd, shown) => {
    expect(locationFor(cwd)).toEqual({ text: shown, title: cwd })
  })

  it('F6 — 折的是 `<盘符>:\\Users\\<一整段用户名>`：用户名整段折掉；`C:\\UsersX\\…` 不是家目录', () => {
    // 用户名整段进 ~，不留尾巴（不是按某个固定用户名做字符串前缀替换）
    expect(locationFor('C:\\Users\\alice2\\x')?.text).toBe('~\\x')
    // Users 必须是完整的一段
    expect(locationFor('C:\\UsersX\\alice\\x')?.text).toBe('C:\\UsersX\\alice\\x')
  })
})
