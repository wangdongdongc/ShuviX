/**
 * artifact 工具 —— 会话 Artifacts 的创建、认领与列举（设计见 docs/session-artifacts-design.md）。
 *
 * 它管的是**存储与身份，不管画图**。手艺在 `builtin:drawing` 技能里，呈现在 ```artifact
 * 引用围栏里；这里只回答「这场会话有哪些东西、它们在磁盘上的哪个路径」。
 *
 * 三个动作对应两条创建路径与一条查询：
 *  - `create` —— 内容经参数写盘。给**本来就是文件**的产物（草稿、数据表、配置）。
 *  - `adopt`  —— 把对话里一张已画出来的 ```svg 图（或一块 ```interactive 交互图，落成 `.html`）
 *    变成可改的文件。**模型零重发**：源码
 *    已在转写里，宿主取出来写盘即可。于是作画可以永远走围栏（流式逐帧画），只有要改时
 *    才付一次拷贝。
 *  - `list`   —— 已有哪些 artifact，以及转写里还有哪些图可以被认领。
 *
 * 两个动作都在返回前 `recordRead`。**注意它买到的不是「让 edit 能用」** —— fileTools/edit.ts
 * 只在「本会话读过」时才校验陈旧，没读过不拦（它自己的注释：「必须先 read 一遍」只是仪式性
 * 约束）。所以零重发不依赖这一笔。它真正买到的是**开启陈旧检测**：有了基线，用户在认领之后
 * 手工改过这张图时，模型的 `edit` 会被 assertNotModifiedSinceRead 拦住，而不是闷头覆盖。
 *
 * **一处裁决过的取舍要写下来**：`securityCheck` 是 no-op、也不过 `enforcePath`，所以这是一条
 * 不经询问的写原语，而 `ask-on-write` 对任何位置的文件写入都要问。`bot` 基座刻意收窄过的
 * 工具清单里现在有它。之所以接受：落点是**会话自己的目录**、碰不到用户仓库。类型白名单里唯一
 * 能执行的是 `html`，而它能做的不超过模型本来就能在回复里写的一块 ```interactive：只在交互图的
 * 沙箱 iframe 里渲染（不透明源、没有网络），落盘时还带一行同样的 CSP，双击用浏览器打开也没有
 * 出口（见 artifacts/store.ts 的 ALLOWED_EXT）。bot「要动就得开子会话」那条不变式针对的是
 * 用户的工作区，这里不构成缺口 —— 但它确实是个没有复核的入口，改动前先回来读这一段。
 *
 * **会话粒度用 ctx.sessionId，不上溯根会话**：子会话是一场普通会话、有自己的转写，而
 * `adopt` 读的正是那份转写 —— 目录跟着转写走，才不会出现「能看见的图认领不到、认领到的
 * 图看不见」。
 */
import { Type } from 'typebox'
import type { TObject, TString } from 'typebox'
import { BaseTool } from '@shuvix/agent-runtime'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { listArtifacts, writeArtifact } from '../services/artifacts/store'
import { adoptFigure, figureArtifactName, listAdoptableFigures } from '../services/artifacts/adopt'
import { messageService } from '../services/messageService'
import { recordRead } from '../utils/toolUtils/fileTime'
import type { ToolContext } from '../services/toolContext'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { t } from '../i18n'

export const ARTIFACT_DESCRIPTION = [
  "Manage this conversation's artifacts: named files the session owns, which you can revise with `edit` instead of regenerating.",
  '',
  '- `list` — what this session already has, plus which figures in the transcript can still be adopted.',
  '- `adopt` — turn a ```svg figure or an ```interactive block you already wrote into a file (`.svg` / `.html`). Give `ref` (its title or its number from `list`); omitted means the most recent one. Nothing is re-sent: the source is taken from the transcript.',
  '- `create` — write a new artifact from `content` (needs `title` and `ext`: svg, md, txt, csv, json, html). Use this for things that are a file first — a draft, a table, a config — not for figures.',
  '',
  'Draw figures with a ```svg or ```interactive fence, not with this tool. Adopt one only when it is about to be changed: the reply then shows the new version with a ```artifact fence naming it.'
].join('\n')

export const ArtifactParamsSchema: TObject<{
  action: TString
  ref: TString
  title: TString
  ext: TString
  content: TString
}> = Type.Object({
  action: Type.String({ description: "One of 'list' | 'adopt' | 'create'" }),
  ref: Type.Optional(
    Type.String({
      description: "adopt: the figure's title or its number from `list`; omit for the most recent"
    })
  ) as unknown as TString,
  title: Type.Optional(
    Type.String({ description: 'create: human title; the file name is derived from it' })
  ) as unknown as TString,
  ext: Type.Optional(
    Type.String({
      description: 'create: extension without the dot — svg, md, txt, csv, json, html'
    })
  ) as unknown as TString,
  content: Type.Optional(
    Type.String({ description: 'create: the file body' })
  ) as unknown as TString
})

interface ArtifactDetails {
  type: 'artifact'
  action: string
  name?: string
}

const text = (s: string): AgentToolResult<ArtifactDetails> => ({
  content: [{ type: 'text' as const, text: s }],
  details: { type: 'artifact', action: 'list' }
})

export class ArtifactTool extends BaseTool<typeof ArtifactParamsSchema> {
  readonly name = 'artifact'
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS.artifact.labelKey)
  readonly description = ARTIFACT_DESCRIPTION
  readonly parameters = ArtifactParamsSchema

  constructor(private readonly ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 只读/只写本会话自己的目录，不吃模型给的路径 —— 没有确定性的路径准入可设 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { action: string; ref?: string; title?: string; ext?: string; content?: string }
  ): Promise<AgentToolResult<ArtifactDetails>> {
    const sessionId = this.ctx.sessionId
    const action = (params.action || '').trim().toLowerCase()

    if (action === 'list') {
      const owned = listArtifacts(sessionId)
      const all = listAdoptableFigures(await messageService.listBySession(sessionId))
      // 已经认领过的图不再算「可认领」：否则模型每次 list 都被邀请再认领一次，而再认领
      // 会把既有编辑分叉掉（adoptFigure 现在幂等，但邀请本身就是误导）
      const ownedNames = new Set(owned.map((a) => a.name.toLowerCase()))
      const figures = all.filter(
        (f) => !ownedNames.has(figureArtifactName(f.title, f.kind).toLowerCase())
      )
      const lines = [
        owned.length
          ? `Artifacts (${owned.length}) — change these with \`edit\`, show them with an \`\`\`artifact fence:\n${owned.map((a) => `  ${a.name} — ${a.title}\n    ${a.path}`).join('\n')}`
          : 'Artifacts: none yet.',
        figures.length
          ? `Figures in the transcript not yet adopted (${figures.length}):\n${figures.map((f) => `  [${f.index}] ${f.title}`).join('\n')}`
          : 'Figures in the transcript not yet adopted: none.'
      ]
      return text(lines.join('\n\n'))
    }

    if (action === 'adopt') {
      const messages = await messageService.listBySession(sessionId)
      const result = adoptFigure({ sessionId, messages, ref: params.ref })
      if (!result) {
        const figures = listAdoptableFigures(messages)
        return text(
          figures.length
            ? `No figure matched "${params.ref ?? ''}". Available: ${figures.map((f) => `[${f.index}] ${f.title}`).join(', ')}`
            : 'There is no ```svg figure or ```interactive block in this conversation to adopt. Draw one first, or use action "create".'
        )
      }
      recordRead(sessionId, result.artifact.path)
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              result.existing
                ? `"${result.figure.title}" was already adopted as ${result.artifact.name} — reusing it, so any earlier edits are intact.`
                : `Adopted "${result.figure.title}" as ${result.artifact.name}.`,
              result.artifact.path,
              '',
              'Change it with `edit` on that path (it counts as already read), then show the new version with:',
              '```artifact',
              result.artifact.name,
              '```'
            ].join('\n')
          }
        ],
        details: { type: 'artifact', action, name: result.artifact.name }
      }
    }

    if (action === 'create') {
      if (!params.title?.trim()) return text('create needs a `title`.')
      if (!params.ext?.trim()) return text('create needs an `ext` (svg, md, txt, csv, json, html).')
      if (params.content === undefined) return text('create needs `content`.')
      // 非法 ext 由 writeArtifact 抛；接住变成回执 —— 另外三条前置校验都是回执，
      // 单这一条抛成工具异常是两种 UI，而且模型拿不到「允许哪些」这条信息
      let made: ReturnType<typeof writeArtifact>
      try {
        made = writeArtifact({
          sessionId,
          title: params.title,
          ext: params.ext,
          content: params.content
        })
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e))
      }
      recordRead(sessionId, made.path)
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Created ${made.name}.`,
              made.path,
              '',
              'Change it with `edit` on that path; show it with:',
              '```artifact',
              made.name,
              '```'
            ].join('\n')
          }
        ],
        details: { type: 'artifact', action, name: made.name }
      }
    }

    return text(`Unknown action "${params.action}". Use one of: list, adopt, create.`)
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'artifact',
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.artifact.labelKey),
  getHint: () => t('tool.artifactHint'),
  factory: (ctx) => new ArtifactTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.artifact.presentation,
  describe: () => ({ description: ARTIFACT_DESCRIPTION, parameters: ArtifactParamsSchema })
})
