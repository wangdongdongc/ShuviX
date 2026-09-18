/**
 * 认领之后的那次 `edit` —— artifact 工具的 `recordRead` 到底买到了什么。
 * 真实临时目录 + 真实 store/adopt + 真实 fileTime + 真实 edit 内核（安全上下文照
 * writeAskWiring/fileToolDepsKnowledge 的桩，免询问开着）。
 *
 * **先纠正一条常被写反的前提**：`fileTools/edit.ts` 只在「本会话读过」时才校验陈旧，
 * **没读过不拦**（它自己的注释：「必须先 read 一遍」只是仪式性约束）。所以「零重发」
 * 并不依赖这一笔 —— AG-4 把这个前提本身钉住，免得哪天又有人按错误的理由改它。
 *
 * `recordRead` 真正买到的是**开启陈旧检测**：有了基线，用户在认领之后手工改过这张图时，
 * 模型的 `edit` 会被 assertNotModifiedSinceRead 拦住，而不是闷头覆盖（AG-2）。
 *
 * **tmp 根刻意不走 realpathSync**（本文件独此一例）：macOS 上 realpath 会把 `/var/folders/…`
 * 解成 `/private/var/folders/…`，而内置策略 protect-system 把 `/private/var` 列为操作系统目录、
 * 对写入一律 deny —— 于是测的就变成那条策略了。realpath 的本意是「recordRead 按路径**字符串**
 * 做键，两侧算出不同字符串时测的是符号链接」；这条路上没有任何一步解析符号链接
 * （`resolveToCwd` 对绝对路径原样返回，statSync 只跟随不改写），所以未解析的那个串在两侧
 * 严格相同，需要的同一性照样成立 —— AG-3/AG-5 的成功本身就是那个同一性的证据。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const state = vi.hoisted(() => ({
  root: '',
  workspace: '',
  messages: [] as ChatMessage[],
  requests: [] as InputRequest[]
}))

vi.mock('../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`
}))
vi.mock('../../services/messageService', () => ({
  messageService: { listBySession: async () => state.messages }
}))
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 知识库那条支线与本文件无关：落点不属于任何 bundle，别把扫描 / git / 检索拖进来
vi.mock('../../services/knowledge/knowledgePaths', () => ({
  locateBundle: () => null,
  isBuiltinBundle: () => false
}))
vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep, join: joinPath } = await import('node:path')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: 'artifact-session', agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        getVars: () => ({
          workspace: state.workspace,
          toolResultsBase: joinPath(state.workspace, '.nonexistent-tool-results'),
          skillsDirs: [],
          memoryDirs: [],
          home: joinPath(state.workspace, '.nonexistent-home'),
          systemDirs: []
        }),
        // 免询问开着：这里验的是陈旧守卫，不是询问链路（那条在 writeAskWiring.test 里）
        getSessionGrants: () => ({ autoAllow: true, allowList: [] }),
        isDirectory: () => false,
        persistGrant: () => {},
        requestUserInput: async (req: InputRequest): Promise<InputResponse> => {
          state.requests.push(req)
          return { kind: 'ask', allowed: true }
        }
      }
    )
  return {
    resolveProjectConfig: () => ({ workingDirectory: state.workspace }),
    getDesktopSecurityContext: makeContext,
    agentActorOf: () => 'shuvix-work/test-model',
    TOOL_ABORTED: 'Aborted'
  }
})

import { ArtifactTool } from '../artifact'
import { makeEditTool } from '../edit'
import { _resetAll, getReadTime } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

let seq = 0
let sid = ''
const ctx = (): ToolContext => ({ sessionId: sid }) as ToolContext
const textOf = (res: AgentToolResult<unknown>): string => (res.content[0] as { text: string }).text

const said = (text: string): AssistantMessage => ({
  id: 'a',
  sessionId: 's',
  role: 'assistant',
  type: 'message',
  blocks: [{ type: 'text', text }],
  content: text,
  model: 'm',
  createdAt: 1,
  metadata: null
})
/** 一张「一个元素一行」的图 —— 那条写法约束正是为了让 `edit` 有稳定锚点 */
const chart = (label: string, second = '30'): string =>
  [
    `<svg viewBox="0 0 100 40" aria-label="${label}">`,
    '  <rect x="0" y="20" width="10" height="20"/>',
    `  <rect x="20" y="10" width="10" height="${second}"/>`,
    '</svg>'
  ].join('\n')

/** 认领当前转写里最后一张图，返回落盘路径 */
const adopt = async (): Promise<string> => {
  const res = await new ArtifactTool(ctx()).execute('c1', { action: 'adopt' } as never)
  const name = (res.details as { name?: string }).name
  expect(name, textOf(res)).toBeDefined()
  return join(state.root, sid, name!)
}

/** 把 mtime 推到 read 基线之后 —— 模拟「用户在认领之后自己改了这张图」 */
const touchLater = (path: string): void => {
  const later = new Date(Date.now() + 10_000)
  utimesSync(path, later, later)
}

/**
 * 让墙上时间过去 >50ms（fileTime 的容差）—— 之后写盘拿到的 mtime 就**确实晚于**先前的
 * read 基线，同时又不在未来。AG-4 需要这个形状，见那条用例的说明。
 */
const pastTolerance = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120))

beforeAll(() => {
  homeBefore = homeSnapshot()
  const base = mkdtempSync(join(tmpdir(), 'shuvix-artifact-edit-'))
  state.root = join(base, 'artifacts')
  state.workspace = join(base, 'workspace')
  mkdirSync(state.workspace, { recursive: true })
})

afterAll(() => {
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

beforeEach(() => {
  sid = `s${++seq}`
  state.messages = []
  state.requests = []
  _resetAll()
})

describe('认领 → edit', () => {
  it('AG-1 认领之后基线就在（陈旧检测已开启）', async () => {
    state.messages = [said(['```svg', chart('Bar chart'), '```'].join('\n'))]
    const path = await adopt()
    expect(getReadTime(sid, path)).toBeInstanceOf(Date)
  })

  it('AG-2 认领 → 用户手改（mtime 推后）→ 模型的 edit 被拒（不闷头覆盖）', async () => {
    state.messages = [said(['```svg', chart('Bar chart'), '```'].join('\n'))]
    const path = await adopt()
    const userEdited = chart('Bar chart', '30').replace('<rect x="0"', '<rect id="mine" x="0"')
    writeFileSync(path, userEdited, 'utf-8')
    touchLater(path)

    const edit = makeEditTool(ctx())
    await expect(
      edit.execute('c2', { path, oldText: 'height="30"', newText: 'height="12"' } as never)
    ).rejects.toThrow(/has been modified since it was last read/)
    // 用户那一笔一个字都没丢
    expect(readFileSync(path, 'utf-8')).toBe(userEdited)
  })

  it('AG-3 认领 → 直接 edit（没人动过盘）⇒ 外科手术式改动落盘，不必重画', async () => {
    state.messages = [said(['```svg', chart('Bar chart'), '```'].join('\n'))]
    const path = await adopt()
    const res = await makeEditTool(ctx()).execute('c2', {
      path,
      oldText: 'height="30"',
      newText: 'height="12"'
    } as never)
    expect(textOf(res)).toContain('Successfully edited')
    const after = readFileSync(path, 'utf-8')
    expect(after).toBe(chart('Bar chart', '12'))
    // 只有那一处变了：其余行逐字保持转写里的样子
    expect(after.split('\n')).toHaveLength(4)
  })

  it('AG-4 前提本身：**没读过不拦** —— 抹掉基线后，同一次用户手改不再拦得住 edit', async () => {
    // 「删掉 recordRead 则 edit 失败」是个错误的论证：edit 只在本会话读过时才校验陈旧
    // （它自己的注释：「必须先 read 一遍」只是仪式性约束）。这里是 AG-2 的反事实 ——
    // 同一件 artifact、同一次用户手改，只把基线抹掉，edit 就跑通了。
    //
    // 为什么这里不用 touchLater 而是真等一会儿再写：没有基线时，edit 会把它内部那次整读
    // 登记为基线，随后**询问之后还有一次二次校验**（见 AG-7）—— 一个在未来的 mtime 照样
    // 过不去。要表达的「没读过不拦」只对**前置**校验成立，所以 mtime 必须是「晚于旧基线、
    // 但仍在过去」的真实时刻。
    state.messages = [said(['```svg', chart('Bar chart'), '```'].join('\n'))]
    const path = await adopt()
    _resetAll() // = artifact 工具没有那一笔 recordRead
    await pastTolerance()
    writeFileSync(path, chart('Bar chart').replace('<rect x="0"', '<rect id="mine" x="0"'), 'utf-8')
    expect(getReadTime(sid, path)).toBeUndefined()

    const res = await makeEditTool(ctx()).execute('c2', {
      path,
      oldText: 'height="30"',
      newText: 'height="12"'
    } as never)
    expect(textOf(res)).toContain('Successfully edited')
    expect(readFileSync(path, 'utf-8')).toContain('height="12"')
  })

  it('AG-7 现状：没有基线时，询问之后的二次校验仍会拦下 mtime 在未来的文件', async () => {
    // 这条解释了 AG-4 为什么必须用「真实的过去时刻」：edit 在内部整读后登记基线、
    // 询问返回后再校验一次，于是一个未来的 mtime 与有没有 recordRead 无关，一律拦下
    const path = join(state.workspace, 'never-read.svg')
    writeFileSync(path, chart('Never read'), 'utf-8')
    touchLater(path)
    expect(getReadTime(sid, path)).toBeUndefined()
    await expect(
      makeEditTool(ctx()).execute('c1', {
        path,
        oldText: 'height="30"',
        newText: 'height="12"'
      } as never)
    ).rejects.toThrow(/has been modified since it was last read/)
    expect(readFileSync(path, 'utf-8')).toBe(chart('Never read'))
  })

  it('AG-5 中文标题：slug 的 NFC 归一与 edit 的路径解析算出同一个字符串', async () => {
    // slugify 做 NFC 归一，而读路径解析会试 NFD 变体 —— 两侧对不上时，认领完的文件
    // 立刻就 edit 不动（报「文件不存在」或「没读过」）
    state.messages = [said(['```svg', chart('各档请求量'), '```'].join('\n'))]
    const path = await adopt()
    expect(path).toBe(join(state.root, sid, '各档请求量.svg'))
    expect(getReadTime(sid, path)).toBeInstanceOf(Date)
    const res = await makeEditTool(ctx()).execute('c2', {
      path,
      oldText: 'height="30"',
      newText: 'height="12"'
    } as never)
    expect(textOf(res)).toContain('Successfully edited')
    expect(readFileSync(path, 'utf-8')).toBe(chart('各档请求量', '12'))
  })

  it('AG-6 认领 → edit → 再认领 ⇒ 拿回被编辑过的那件（幂等与陈旧检测合起来的主线）', async () => {
    state.messages = [said(['```svg', chart('Bar chart'), '```'].join('\n'))]
    const path = await adopt()
    await makeEditTool(ctx()).execute('c2', {
      path,
      oldText: 'height="30"',
      newText: 'height="12"'
    } as never)

    const again = await new ArtifactTool(ctx()).execute('c3', { action: 'adopt' } as never)
    expect(textOf(again)).toContain('was already adopted')
    // 新建的话这里会是转写里的原始源码（height="30"），用户看到的是「我的修改被撤销了」
    expect(readFileSync(path, 'utf-8')).toBe(chart('Bar chart', '12'))
    expect(readdirSync(join(state.root, sid)).sort()).toEqual(['bar-chart.svg'])
  })
})
