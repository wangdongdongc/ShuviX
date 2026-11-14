/**
 * 提示词块（`shuvix-prompt-blocks`）：档案正文是纯文字，会话相关的内容由宿主渲染成块、各包在一个 XML 标签里
 * 追加在正文后面（2026-11-13，取代 `{{shuvix:*}}` 变量）。这里端到端钉：
 *  - 内置基座列了 `environment`：清单里的事实（平台、本地日期、工作目录、git）与「临时文件」那一行
 *    （主进程启动时注入的会话临时目录解析器 —— 单测替身够不到这处接线）；
 *  - 用户档案列了哪几块就追加哪几块，没列就一块都没有；清单是集合（先后由宿主固定、大小写不限、
 *    不认识的名字忽略）；环境清单的行按 agent 手里的工具给；
 *  - 正文里残留的 `{{shuvix:x}}` 不再替换，原样到模型那里。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { platform } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createAgentSession,
  createPinnedChildSession,
  createProject,
  writeAgentMd
} from '../../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

/** `<name>` 与 `</name>` 之间的正文（不含两个标签）；没有这一块回 null */
const blockOf = (sp: string, name: string): string | null => {
  const open = `<${name}>\n`
  const close = `\n</${name}>`
  const start = sp.indexOf(open)
  const end = sp.indexOf(close, start)
  return start === -1 || end === -1 ? null : sp.slice(start + open.length, end)
}

/** 用一份覆盖档案顶替 chat 基座建一条无项目会话，取它的系统提示词；用完删掉覆盖档案 */
const withChatOverride = async (
  seed: Parameters<typeof writeAgentMd>[2],
  check: (systemPrompt: string) => void | Promise<void>
): Promise<void> => {
  // 覆盖 chat：这里用的是**无项目**会话，它的基座是 chat 而非 work
  writeAgentMd(app, 'chat', { description: 'ovr', ...seed })
  try {
    const { systemPrompt } = await createAgentSession(app.main)
    await check(systemPrompt)
  } finally {
    await app.main.eval(`window.api.subAgent.delete({ name: 'chat' })`)
  }
}

describe('内置基座的 environment 块', () => {
  it('无项目会话（chat 基座）：环境清单在 <environment> 里，事实齐全、没有空行，正文无残留占位符', async () => {
    const { systemPrompt: sp } = await createAgentSession(app.main)
    expect(sp).not.toContain('{{shuvix:')
    const env = blockOf(sp, 'environment')
    expect(env, sp).not.toBeNull()
    expect(env).toContain(`- Platform: ${platform()}`)
    // 提示词里的日期是**本地**日期（agent-runtime dateNotice 的写法）；toISOString 是 UTC，在美西的
    // 17:00–24:00 两者差一天，这条曾因此每晚失败
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(env).toContain(
      `- Current date: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    )
    // chat 基座带文件工具与命令工具：工作目录打头，Shell / OS / Git 三行都在
    expect(env).toMatch(/^- Working directory: \//)
    expect(env).toMatch(/\n- Git repository: /)
    expect(env).toMatch(/\n- Shell: /)
    expect(env).toMatch(/\n- OS: /)
    expect(env).toMatch(/\n- ShuviX version: ShuviX /)
    // 一行一项：清单里没有空行（没给的事实整行不出，不留空位）
    expect(env).not.toMatch(/\n[ \t]*\n/)
    expect(sp).toBe(sp.trim())
  })

  it('「临时文件」一行：紧跟工作目录那一行，路径是本会话的临时目录、已经建好（启动时注入的解析器接上了）', async () => {
    const { sid, systemPrompt: sp } = await createAgentSession(app.main)
    // chat 基座带 bash：那一行连「命令的临时目录也是它」一起说
    const line = sp.match(
      /^- Temporary files: `([^`]+)` — .*, also its commands' temp directory\./m
    )
    expect(line, sp).not.toBeNull()
    const dir = line![1]
    if (process.platform === 'darwin') {
      expect(sp).toMatch(
        /^- Temporary files: `\/private\/tmp\/shuvix-\d+\/[0-9a-f]{8}` — .*, also its commands' temp directory\./m
      )
    }
    // 是这条会话自己的那一个（目录名按会话 id 算）
    expect(basename(dir)).toBe(createHash('sha256').update(sid).digest('hex').slice(0, 8))
    expect(existsSync(dir)).toBe(true)
    // 环境清单里紧跟工作目录那一行
    expect(sp).toMatch(/\n- Working directory: [^\n]+\n- Temporary files: `/)
  })

  it('项目会话（work 基座）：工作目录 = 项目路径、git 检测生效', async () => {
    const projDir = join(app.home, 'proj-blocks')
    mkdirSync(join(projDir, '.git'), { recursive: true })
    const project = await createProject(app.main, { name: 'BlocksProj', path: projDir })
    const { systemPrompt: sp } = await createAgentSession(app.main, { projectId: project.id })
    const env = blockOf(sp, 'environment')
    expect(env, sp).not.toBeNull()
    expect(env).toContain(`- Working directory: ${projDir}\n`)
    expect(env).toContain('- Git repository: Yes\n')
    expect(sp).not.toContain('{{shuvix:')
  })
})

describe('用户档案的提示词块', () => {
  it('列了 environment → 正文原样打头，后面追加 <environment> 块；正文里残留的 {{shuvix:x}} 原样保留', async () => {
    const body = 'OVR dir={{shuvix:workingDirectory}} plat={{shuvix:platform}} bad={{shuvix:typo}}'
    await withChatOverride({ tools: 'read', promptBlocks: 'environment', body }, (sp) => {
      // 正文是纯文字：占位符不再替换（已知的、未知的都一样），块隔一个空行追加在后面
      expect(sp.startsWith(`${body}\n\n<environment>\n- Working directory: /`)).toBe(true)
      const env = blockOf(sp, 'environment')
      expect(env).toContain(`- Platform: ${platform()}`)
      // 只有 read：有文件工具 → 工作目录与临时目录两行在；没有命令工具 → Shell / OS / Git 三行不在
      expect(env).toMatch(/\n- Temporary files: `/)
      expect(env).not.toContain('- Shell: ')
      expect(env).not.toContain('- OS: ')
      expect(env).not.toContain('- Git repository: ')
      // 没列的块不追加
      expect(sp).not.toContain('<drawing>')
      expect(sp).not.toContain('<document>')
    })
  })

  it('没有文件工具的 agent：environment 里没有工作目录与临时目录两行，恒有的那几行照常', async () => {
    await withChatOverride(
      { tools: 'ask', promptBlocks: 'environment', body: 'NO FILES BODY.' },
      (sp) => {
        const env = blockOf(sp, 'environment')
        expect(env, sp).not.toBeNull()
        expect(env).not.toContain('- Working directory: ')
        expect(env).not.toContain('- Temporary files: ')
        expect(env).toMatch(/^- Platform: /)
        expect(env).toMatch(/\n- Current date: \d{4}-\d{2}-\d{2}/)
        expect(env).toMatch(/\n- User language: /)
        expect(env).toMatch(/\n- ShuviX version: ShuviX /)
      }
    )
  })

  it('没列任何块 → 一块都不追加：没有 <environment>，也没有工作目录那一行', async () => {
    await withChatOverride({ tools: 'read', body: 'BARE BODY.' }, (sp) => {
      expect(sp.startsWith('BARE BODY.')).toBe(true)
      expect(sp).not.toContain('<environment>')
      expect(sp).not.toContain('Working directory:')
      expect(sp).not.toContain('<drawing>')
      expect(sp).not.toContain('<project_prompt>')
      expect(sp).not.toContain('<project_instructions')
    })
  })

  it('drawing 块跟着技能工具走：列了但手里没有 skill → 整块不出；有 skill → <drawing> 在 <environment> 之前', async () => {
    await withChatOverride(
      { tools: 'read', promptBlocks: 'environment, drawing', body: 'NO SKILL BODY.' },
      (sp) => {
        expect(sp).not.toContain('<drawing>')
        expect(blockOf(sp, 'environment')).not.toBeNull()
      }
    )
    // 清单里 environment 写在前面：先后由宿主固定（drawing 在 environment 之前），与书写顺序无关
    await withChatOverride(
      { tools: 'read, skill', promptBlocks: 'environment, drawing', body: 'SKILL BODY.' },
      (sp) => {
        const iDrawing = sp.indexOf('<drawing>\n')
        expect(iDrawing, sp).toBeGreaterThan(-1)
        expect(sp.indexOf('</drawing>')).toBeGreaterThan(iDrawing)
        expect(sp.indexOf('<environment>\n')).toBeGreaterThan(sp.indexOf('</drawing>'))
        // 作图说明只点名一次要加载的技能
        expect(blockOf(sp, 'drawing')).toContain('builtin:drawing')
      }
    )
  })

  it('清单是集合：大小写不限、不认识的名字忽略（档案照常可用），块按宿主的次序出', async () => {
    const projDir = join(app.home, 'proj-blocks-set')
    mkdirSync(projDir, { recursive: true })
    const project = await createProject(app.main, {
      name: 'BlocksSetProj',
      path: projDir,
      systemPrompt: 'SET PROJECT PROMPT.'
    })
    // project_prompt 写在 environment 前面、夹一个词表里没有的名字、大小写乱写
    writeAgentMd(app, 'blocks-set', {
      tools: 'read',
      promptBlocks: 'Project_Prompt, no_such_block, ENVIRONMENT',
      body: 'SET BODY.'
    })
    const names = await app.main.eval<string[]>(
      `window.api.subAgent.list().then((rows) => rows.map((r) => r.name))`
    )
    // 不认识的名字只是被忽略：整份档案不因此非法
    expect(names).toContain('blocks-set')

    // 根会话的档案由形态推导，用带戳的子会话跑这份档案（projectId 随父）
    const parent = (await createAgentSession(app.main, { projectId: project.id })).sid
    const child = await createPinnedChildSession(app, {
      parentSid: parent,
      agentProfile: 'blocks-set'
    })
    const sp = await app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(child)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )
    expect(sp.startsWith('SET BODY.\n\n<environment>\n')).toBe(true)
    expect(blockOf(sp, 'environment')).toContain(`- Working directory: ${projDir}\n`)
    expect(sp).toContain('<project_prompt>\nSET PROJECT PROMPT.\n</project_prompt>')
    expect(sp.indexOf('<project_prompt>')).toBeGreaterThan(sp.indexOf('</environment>'))
    expect(sp).not.toContain('no_such_block')
  })
})
