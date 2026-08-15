/**
 * 笔记本一次性子智能体的信封组装 —— 只关心「档案声明的模型有没有原样送进 runTask」。
 * 用 fake manager 捕获入参，不引入真 SubAgentManager。
 */
import { describe, it, expect, vi } from 'vitest'
import { runNotebookTask, type NotebookTaskInputs } from '../notebookContext'
import type { SubAgentManager } from '../manager'
import type { SubAgentModelConfig } from '../types'

const SESSION_MODEL: SubAgentModelConfig = {
  provider: 'p-session',
  model: 'm-session',
  capabilities: {}
}

function makeInputs(overrides: Partial<NotebookTaskInputs> = {}): NotebookTaskInputs {
  return {
    sessionId: 'nb-1',
    text: '整理这页笔记',
    systemPrompt: 'NOTEBOOK BODY',
    modelConfig: SESSION_MODEL,
    tools: ['read', 'write'],
    ...overrides
  }
}

/** 捕获 runTask 入参的 fake manager */
function makeManager(): { manager: SubAgentManager; runTask: ReturnType<typeof vi.fn> } {
  const runTask = vi.fn().mockResolvedValue({ result: 'done' })
  return { manager: { runTask } as unknown as SubAgentManager, runTask }
}

describe('runNotebookTask', () => {
  it('inputs.model 原样出现在 agentType.model（会话模型仍单独经 modelConfig 传）', async () => {
    const { manager, runTask } = makeManager()
    await runNotebookTask(manager, makeInputs({ model: 'openai/gpt-4o' }), vi.fn())

    const arg = runTask.mock.calls[0][0]
    expect(arg.agentType.model).toBe('openai/gpt-4o')
    expect(arg.modelConfig).toBe(SESSION_MODEL)
  })

  it('未声明模型 → agentType.model 为 undefined（跟随会话所选）', async () => {
    const { manager, runTask } = makeManager()
    await runNotebookTask(manager, makeInputs(), vi.fn())

    expect(runTask.mock.calls[0][0].agentType.model).toBeUndefined()
  })

  it('两个注入开关一并透传（用户覆盖 notebook 档案打开即生效）', async () => {
    const { manager, runTask } = makeManager()
    await runNotebookTask(
      manager,
      makeInputs({ model: 'openai/gpt-4o', instructionFiles: true, projectPrompt: true }),
      vi.fn()
    )

    const { agentType } = runTask.mock.calls[0][0]
    expect(agentType.instructionFiles).toBe(true)
    expect(agentType.projectPrompt).toBe(true)
    expect(agentType.systemPrompt).toBe('NOTEBOOK BODY')
    expect(agentType.tools).toEqual(['read', 'write'])
  })
})
