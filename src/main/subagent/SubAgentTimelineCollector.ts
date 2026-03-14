/**
 * SubAgentTimelineCollector — 在主进程中收集子智能体事件，
 * 序列化为持久化时间线，写入 ToolUseMeta.details
 */

import type { ChatEvent } from '../frontend'
import type {
  PersistedSubAgentTimelineEntry,
  PersistedSubAgentUsage
} from '../../shared/types/chatMessage'

interface InternalToolEntry {
  toolName: string
  status: 'running' | 'done' | 'error'
  summary?: string
}

interface InternalEntry {
  type: 'tool' | 'text'
  tool?: InternalToolEntry
  content?: string
  toolCallId?: string
}

const MAX_TEXT_CHARS = 2000
const MAX_ENTRIES = 200

/**
 * 收集子智能体事件流并序列化为持久化时间线。
 * 每个子智能体工具调用创建一个实例。
 */
export class SubAgentTimelineCollector {
  private entries: InternalEntry[] = []
  private usage: PersistedSubAgentUsage | undefined
  private targetSubAgentId: string | undefined

  /**
   * 处理 ChatEvent，收集子智能体相关事件。
   * 同时作为透传包装器：总是返回 void，不阻断事件流。
   */
  onEvent(event: ChatEvent): void {
    // 捕获 subAgentId（从 start 事件获取）
    if (event.type === 'subagent_start') {
      this.targetSubAgentId = event.subAgentId
      return
    }

    // 只处理目标子智能体的事件
    if (!('subAgentId' in event) || !this.targetSubAgentId) return
    if ((event as { subAgentId: string }).subAgentId !== this.targetSubAgentId) return

    switch (event.type) {
      case 'subagent_tool_start':
        this.entries.push({
          type: 'tool',
          toolCallId: event.toolCallId,
          tool: {
            toolName: event.toolName,
            status: 'running',
            summary: this.extractArgsSummary(event.toolArgs)
          }
        })
        break

      case 'subagent_tool_end':
        this.updateTool(event.toolCallId, event.toolName, event.result, event.isError)
        break

      case 'subagent_text_delta':
        this.appendContent('text', event.delta)
        break

      case 'subagent_thinking_delta':
        // 子智能体的 thinking 内容也作为 text 持久化（与 ACP 行为一致）
        this.appendContent('text', event.delta)
        break

      case 'subagent_end':
        if (event.usage && event.usage.total > 0) {
          this.usage = {
            input: event.usage.input,
            output: event.usage.output,
            cacheRead: event.usage.cacheRead,
            cacheWrite: event.usage.cacheWrite,
            total: event.usage.total,
            details: event.usage.details
          }
        }
        break
    }
  }

  /** 序列化为持久化格式 */
  serialize(): {
    timeline: PersistedSubAgentTimelineEntry[] | undefined
    usage: PersistedSubAgentUsage | undefined
  } {
    if (this.entries.length === 0) {
      return { timeline: undefined, usage: this.usage }
    }

    // 截断条目数
    const entries = this.entries.slice(-MAX_ENTRIES)

    const timeline: PersistedSubAgentTimelineEntry[] = entries
      .map((e): PersistedSubAgentTimelineEntry | null => {
        switch (e.type) {
          case 'tool':
            if (!e.tool) return null
            return {
              type: 'tool',
              tool: {
                toolName: e.tool.toolName,
                status: e.tool.status === 'running' ? 'done' : e.tool.status,
                summary: e.tool.summary || undefined
              }
            }
          case 'text':
            if (!e.content) return null
            return {
              type: 'text',
              content:
                e.content.length > MAX_TEXT_CHARS ? e.content.slice(-MAX_TEXT_CHARS) : e.content
            }
          default:
            return null
        }
      })
      .filter((e): e is PersistedSubAgentTimelineEntry => e !== null)

    return {
      timeline: timeline.length > 0 ? timeline : undefined,
      usage: this.usage
    }
  }

  // ─── 内部方法 ──────────────────────────────────────────

  private updateTool(
    toolCallId: string,
    toolName?: string,
    result?: string,
    isError?: boolean
  ): void {
    const entry = this.findToolEntry(toolCallId)
    if (!entry?.tool) return

    // 仅在有终态标记时更新 status
    if (result != null || isError != null) {
      entry.tool.status = isError ? 'error' : 'done'
    }

    // 更新工具名（ACP 中间更新携带 title）
    if (toolName) {
      entry.tool.toolName = toolName
      // ACP title 通常已包含摘要信息（如 "Read /path/to/file"），直接用作 summary
      if (toolName.includes('/') || toolName.length > 20) {
        entry.tool.summary = undefined // toolName 本身就是摘要
      }
    }
  }

  private appendContent(type: 'text', delta: string): void {
    const last = this.entries[this.entries.length - 1]
    if (last && last.type === type) {
      last.content = (last.content || '') + delta
    } else {
      this.entries.push({ type, content: delta })
    }
  }

  /** 从工具参数中提取第一个合理长度的字符串值作为摘要 */
  private extractArgsSummary(args?: Record<string, unknown>): string | undefined {
    if (!args) return undefined
    for (const v of Object.values(args)) {
      if (typeof v !== 'string' || !v) continue
      const line = v.split('\n')[0]
      if (line.length <= 200) {
        return line.length > 80 ? line.slice(0, 77) + '...' : line
      }
    }
    return undefined
  }

  private findToolEntry(toolCallId: string): InternalEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === 'tool' && this.entries[i].toolCallId === toolCallId) {
        return this.entries[i]
      }
    }
    return undefined
  }
}
