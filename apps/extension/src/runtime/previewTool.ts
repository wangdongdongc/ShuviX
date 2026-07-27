/**
 * 扩展 preview 工具 —— 复用 @shuvix/agent-runtime 的共享 createPreviewTool 内核。
 *
 * 端适配：路径是工作目录（FSA/OPFS 根句柄）相对路径；事件 absPath 用 UI 路径空间
 * `root.name/rel`（与 files.changed / FilesPanel 的 projectPath=scan.root 约定一致），
 * 共享 FilesPanel 收到 filePreviewRequest 后 relativize 即可打开预览。
 * 事件经 eventBus 以根会话 sessionId 广播（共享 useAgentEvents 仅活跃会话响应）。
 *
 * 结果反馈：分类经同一个 previewFile 内核（FSA port）；图表渲染验证无需回执通道 ——
 * 工具本就跑在浏览器里（Side Panel 同进程），直接调与 ChartView 同款 renderMermaid。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import i18next from 'i18next'
import { createPreviewTool, previewFile } from '@shuvix/agent-runtime'
import { renderMermaid } from '@shuvix/atomic-editor'
import { eventBus } from './eventBus'
import { handleForSession } from './filesRuntime'
import { createFsaPort } from './fsaPort'

/** 归一为句柄相对路径：容忍 UI 形态（root.name/rel）与前导斜杠；拒绝 '..' 逃逸 */
function normalizeRel(path: string, rootName: string): string {
  let rel = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel === rootName) rel = ''
  else if (rel.startsWith(`${rootName}/`)) rel = rel.slice(rootName.length + 1)
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new Error(
      `Cannot preview ${path}: the Files panel can only preview files inside the working directory`
    )
  }
  return rel
}

/** 创建扩展 preview 工具（绑定根会话；执行时惰性解析工作目录句柄） */
export function createExtensionPreviewTool(rootSessionId: string): AgentTool {
  return createPreviewTool({
    port: {
      stat: async (statPath) => {
        const handle = await handleForSession(rootSessionId)
        if (!handle) return null
        return createFsaPort(handle).stat(statPath)
      }
    },
    resolvePath: async (p) => {
      const handle = await handleForSession(rootSessionId)
      if (!handle) throw new Error('No working directory is available for this session')
      const rel = normalizeRel(p, handle.name)
      return { statPath: rel, absPath: rel ? `${handle.name}/${rel}` : handle.name }
    },
    // 与 FilesPanel 预览同一个分类内核（FSA port；句柄执行时惰性解析）
    readPreview: async (statPath, absPath) => {
      const handle = await handleForSession(rootSessionId)
      if (!handle) {
        return { kind: 'error', path: absPath, message: 'No working directory for this session' }
      }
      return previewFile(createFsaPort(handle), statPath, absPath)
    },
    // 工具跑在浏览器里：直接用与 ChartView 同款管线验证（主题与有效性无关，固定 default）
    validateChart: async ({ mermaid }) => {
      const r = await renderMermaid(mermaid, { theme: 'default' })
      return { ok: !!r.svg && !r.error, error: r.error, verified: true }
    },
    emitFilePreview: (absPath) =>
      eventBus.emit({ type: 'file_preview', sessionId: rootSessionId, absPath }),
    label: i18next.t('tool.previewLabel'),
    abortError: 'TOOL_ABORTED'
  }) as unknown as AgentTool
}
