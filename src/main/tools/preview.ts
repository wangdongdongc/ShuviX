/**
 * Preview 工具 — 预览面板控制 + 浏览器自动化
 *
 * 两级分发：
 * - action: open/close/help  → 面板生命周期
 * - action: devtools          → 自动化（通过 devtools_action 二级分发）
 */

import { Type } from '@sinclair/typebox'
import { BaseTool, type ToolContext } from './types'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { PreviewToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { registerBuiltinTool } from './registry'
import { previewCdpService } from '../services/previewCdpService'
import {
  snapshotAction,
  screenshotAction,
  clickAction,
  fillAction,
  typeAction,
  pressKeyAction,
  scrollAction,
  evaluateAction,
  waitForAction,
  navigateAction,
  getNetworkRequestsAction,
  getConsoleMessagesAction
} from '../services/previewCdpActions'

// ====== Schema ======

const PreviewParamsSchema = Type.Object({
  action: Type.Unsafe<'open' | 'close' | 'help' | 'devtools'>({
    type: 'string',
    enum: ['open', 'close', 'help', 'devtools'],
    description:
      'Action: "open"/"close" control the panel; "devtools" performs browser automation (snapshot, click, type, screenshot, etc.); "help" returns detailed documentation for all devtools actions.'
  }),
  url: Type.Optional(
    Type.String({
      description: 'URL to open in the preview panel (required for action="open").'
    })
  ),
  devtools_action: Type.Optional(
    Type.Unsafe<string>({
      type: 'string',
      enum: [
        'snapshot',
        'screenshot',
        'click',
        'type',
        'fill',
        'press_key',
        'scroll',
        'evaluate',
        'wait_for',
        'navigate',
        'get_network_requests',
        'get_console_messages'
      ],
      description: 'DevTools action to perform (required when action="devtools").'
    })
  ),
  devtools_params: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Parameters for the devtools action. Use action="help" to see available parameters for each devtools action.'
    })
  )
})

// ====== Help 文本 ======

/** DevTools 操作的使用说明（参数错误时也会附带返回） */
export const DEVTOOLS_HELP = `### DevTools Actions (action="devtools", devtools_action=...)

**Observation**
- **snapshot**: Capture accessibility tree with element UIDs. No params.
  Returns indented text tree, e.g. \`uid=e3 button "Submit"\`.
  Always take a snapshot before using click/fill/type.
- **screenshot**: Capture page image. Params: { fullPage?: boolean, uid?: string }

**Interaction**
- **click**: Click element. Params: { uid } (required). uid comes from snapshot.
- **fill**: Fill input/select. Params: { uid, value } (required)
- **type**: Type into focused element. Params: { text } (required). Optional: { uid, submitKey }
- **press_key**: Press key combo. Params: { key } (required, e.g. "Enter", "Control+A")
- **scroll**: Scroll page. Optional: { direction: "up"|"down"|"left"|"right", amount: 500, uid }

**Navigation**
- **navigate**: Navigate page. Params: { navigateAction: "goto"|"back"|"forward"|"reload", url }

**Evaluation**
- **evaluate**: Execute JavaScript. Params: { expression } (required). Returns JSON result.

**Waiting**
- **wait_for**: Wait for text on page. Params: { text } (required). Optional: { timeout: 10000 }

**Debugging**
- **get_network_requests**: List captured HTTP requests since last navigation.
- **get_console_messages**: List captured console messages since last navigation.

### Typical Workflow
1. preview({ action: "open", url: "..." })
2. preview({ action: "devtools", devtools_action: "snapshot" })
3. preview({ action: "devtools", devtools_action: "click", devtools_params: { uid: "e7" } })
4. preview({ action: "devtools", devtools_action: "screenshot" })`

const HELP_TEXT = `## Preview Tool — Browser Automation Reference

### Panel
- **open**: Open preview at URL. Params: url (required)
- **close**: Close preview panel.

${DEVTOOLS_HELP}`

// ====== Tool ======

type PreviewParams = {
  action: 'open' | 'close' | 'help' | 'devtools'
  url?: string
  devtools_action?: string
  devtools_params?: Record<string, unknown>
}

export class PreviewTool extends BaseTool<typeof PreviewParamsSchema> {
  readonly name = 'preview'
  get label(): string {
    return t('tool.previewLabel')
  }
  get hint(): string {
    return t('tool.previewHint')
  }
  readonly description =
    'Control the preview panel and automate browser interactions. Use action="open" with url to display a web page. Use action="close" to hide the panel. Use action="devtools" with devtools_action to perform browser automation (snapshot, screenshot, click, type, fill, press_key, scroll, navigate, evaluate, wait_for, get_network_requests, get_console_messages). Use action="help" for detailed usage and parameters of each devtools action.'
  readonly parameters = PreviewParamsSchema
  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: PreviewParams
  ): Promise<AgentToolResult<PreviewToolDetails | undefined>> {
    switch (params.action) {
      case 'help':
        return {
          content: [{ type: 'text', text: HELP_TEXT }],
          details: undefined
        }

      case 'open': {
        if (!params.url) {
          return {
            content: [{ type: 'text', text: 'Error: "url" is required when action is "open".' }],
            details: undefined
          }
        }
        this.ctx.emitChatEvent?.({ type: 'preview_event', action: 'open', url: params.url })
        return {
          content: [{ type: 'text', text: `Preview panel opened at ${params.url}.` }],
          details: { type: 'preview', action: 'open', url: params.url }
        }
      }

      case 'close': {
        this.ctx.emitChatEvent?.({ type: 'preview_event', action: 'close' })
        previewCdpService.detach()
        return {
          content: [{ type: 'text', text: 'Preview panel closed.' }],
          details: { type: 'preview', action: 'close' }
        }
      }

      case 'devtools':
        return this.handleDevtools(params.devtools_action, params.devtools_params || {})

      default:
        return {
          content: [{ type: 'text', text: `Unknown action: "${params.action}".` }],
          details: undefined
        }
    }
  }

  private async handleDevtools(
    devtoolsAction: string | undefined,
    devtoolsParams: Record<string, unknown>
  ): Promise<AgentToolResult<PreviewToolDetails>> {
    if (!devtoolsAction) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: "devtools_action" is required when action="devtools".\n\n${DEVTOOLS_HELP}`
          }
        ],
        details: {
          type: 'preview',
          action: 'devtools',
          error: 'missing devtools_action'
        }
      }
    }

    switch (devtoolsAction) {
      case 'snapshot':
        return snapshotAction()
      case 'screenshot':
        return screenshotAction(devtoolsParams)
      case 'click':
        return clickAction(devtoolsParams)
      case 'fill':
        return fillAction(devtoolsParams)
      case 'type':
        return typeAction(devtoolsParams)
      case 'press_key':
        return pressKeyAction(devtoolsParams)
      case 'scroll':
        return scrollAction(devtoolsParams)
      case 'evaluate':
        return evaluateAction(devtoolsParams)
      case 'wait_for':
        return waitForAction(devtoolsParams)
      case 'navigate':
        return navigateAction(devtoolsParams)
      case 'get_network_requests':
        return getNetworkRequestsAction()
      case 'get_console_messages':
        return getConsoleMessagesAction()
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown devtools_action: "${devtoolsAction}".\n\n${DEVTOOLS_HELP}`
            }
          ],
          details: {
            type: 'preview',
            action: 'devtools',
            devtoolsAction,
            error: 'unknown action'
          }
        }
    }
  }
}

registerBuiltinTool({
  name: 'preview',
  group: 'general',
  defaultEnabled: false,
  getLabel: () => t('tool.previewLabel'),
  getHint: () => t('tool.previewHint'),
  factory: (ctx) => new PreviewTool(ctx),
  presentation: {
    icon: 'Monitor',
    iconColor: '#60a5fa',
    summaryField: 'action'
  }
})
