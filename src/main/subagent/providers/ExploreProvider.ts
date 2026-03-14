/**
 * ExploreProvider — 只读代码库搜索子智能体
 *
 * 进程内子智能体，通过 SubAgentManager 管理 Agent 实例。
 * 工具集固定为 read/ls/grep/glob，不可写入。
 */

import { Type } from '@sinclair/typebox'
import type {
  SubAgentModelConfig,
  SubAgentProvider,
  SubAgentRunParams,
  SubAgentRunResult
} from '../types'
import { subAgentManager, type InProcessAgentType } from '../SubAgentManager'
import { t } from '../../i18n'

/** explore 子智能体类型配置 */
const EXPLORE_TYPE: InProcessAgentType = {
  name: 'explore',
  description:
    'Fast read-only agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
  tools: ['read', 'ls', 'grep', 'glob'],
  maxTurns: 40,
  systemPrompt: `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Ls for listing directory contents
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files or run commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`
}

/** explore 工具参数 schema（含 task_id 用于恢复会话） */
const ExploreParamsSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task'
  }),
  prompt: Type.String({
    description:
      'The task for the agent to perform. This is the ONLY context the sub-agent receives — it does NOT have access to your conversation history. Be thorough and specific.'
  }),
  task_id: Type.Optional(
    Type.String({
      description:
        'Resume a previous explore session by providing its task_id. The sub-agent retains its full conversation history from the previous run.'
    })
  )
})

/** 构建 explore 工具描述 */
function buildExploreDescription(): string {
  return `Launch a read-only sub-agent to explore the codebase autonomously in an isolated context. Use explore for broad codebase exploration and context gathering — this saves your context window.

${EXPLORE_TYPE.description}

When NOT to use this tool:
- If you want to read a specific file path, use Read directly
- If you are searching for a specific class/function definition, use Grep/Glob directly
- If you are searching within 2-3 known files, use Read directly

Usage notes:
- Launch multiple explore agents concurrently whenever possible (multiple tool calls in one message)
- The sub-agent does NOT share your conversation history — you MUST provide complete context in the prompt parameter
- The result is returned only to you, not visible to the user — summarize it for the user
- Specify what information the agent should return in its final response
- Each invocation starts fresh unless you provide task_id to resume a previous session`
}

export class ExploreProvider implements SubAgentProvider {
  readonly name = 'explore'
  readonly displayName = t('tool.exploreLabel')
  readonly description = buildExploreDescription()
  readonly parameterSchema = ExploreParamsSchema

  private modelConfig?: SubAgentModelConfig

  /** 注入模型配置（由 agentToolBuilder 调用） */
  setModelConfig(config: SubAgentModelConfig): void {
    this.modelConfig = config
  }

  async runTask(params: SubAgentRunParams): Promise<SubAgentRunResult> {
    if (!this.modelConfig) {
      throw new Error('ExploreProvider requires model config — call setModelConfig() first')
    }

    const { taskId, result } = await subAgentManager.runTask({
      parentSessionId: params.ctx.sessionId,
      parentToolCallId: params.toolCallId,
      taskId: params.taskId,
      agentType: EXPLORE_TYPE,
      prompt: params.prompt,
      modelConfig: this.modelConfig,
      parentAbortSignal: params.signal,
      onEvent: params.onEvent
    })

    return { taskId, result }
  }

  destroy(sessionId: string): void {
    subAgentManager.destroyAll(sessionId)
  }

  abortAll(sessionId: string): void {
    subAgentManager.abortAll(sessionId)
  }
}
