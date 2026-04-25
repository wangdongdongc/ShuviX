/**
 * Browser 工具 — 浏览器面板控制 + 浏览器自动化
 *
 * 两级分发：
 * - action: open/close/help  → 面板生命周期
 * - action: devtools          → 自动化（通过 devtools_action 二级分发）
 */

import { Type } from '@sinclair/typebox'
import { BaseTool } from '../services/baseTool'
import { type ToolContext } from '../services/toolContext'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { BrowserToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { registerBuiltinTool } from '../services/toolRegistry'
import {
  browserCdpService,
  DEVTOOLS_HELP,
  snapshotAction,
  screenshotAction,
  printToPdfAction,
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
} from '../services/browser'

// ====== Schema ======

const BrowserParamsSchema = Type.Object({
  action: Type.Unsafe<'open' | 'close' | 'help' | 'devtools'>({
    type: 'string',
    enum: ['open', 'close', 'help', 'devtools'],
    description:
      'Action: "open"/"close" control the panel; "devtools" performs browser automation (snapshot, click, type, screenshot, etc.); "help" returns detailed documentation for all devtools actions.'
  }),
  url: Type.Optional(
    Type.String({
      description: 'URL to open in the browser panel (required for action="open").'
    })
  ),
  devtools_action: Type.Optional(
    Type.Unsafe<string>({
      type: 'string',
      enum: [
        'snapshot',
        'screenshot',
        'print_to_pdf',
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

const HELP_TEXT = `## Browser Tool — Browser Automation Reference

### Panel
- **open**: Open the browser panel at URL. Params: url (required)
- **close**: Close the browser panel.

${DEVTOOLS_HELP}`

// ====== Tool ======

type BrowserParams = {
  action: 'open' | 'close' | 'help' | 'devtools'
  url?: string
  devtools_action?: string
  devtools_params?: Record<string, unknown>
}

export class BrowserTool extends BaseTool<typeof BrowserParamsSchema> {
  readonly name = 'browser'
  get label(): string {
    return t('tool.browserLabel')
  }
  get hint(): string {
    return t('tool.browserHint')
  }
  readonly description =
    'Control the embedded browser panel and automate browser interactions. Use action="open" with url to display a web page. Use action="close" to hide the panel. Use action="devtools" with devtools_action to perform browser automation (snapshot, screenshot, click, type, fill, press_key, scroll, navigate, evaluate, wait_for, get_network_requests, get_console_messages). Use action="help" for detailed usage and parameters of each devtools action.'
  readonly parameters = BrowserParamsSchema
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
    params: BrowserParams
  ): Promise<AgentToolResult<BrowserToolDetails | undefined>> {
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
        this.ctx.emitChatEvent?.({ type: 'browser_event', action: 'open', url: params.url })
        return {
          content: [{ type: 'text', text: `Browser panel opened at ${params.url}.` }],
          details: { type: 'browser', action: 'open', url: params.url }
        }
      }

      case 'close': {
        this.ctx.emitChatEvent?.({ type: 'browser_event', action: 'close' })
        browserCdpService.detach()
        return {
          content: [{ type: 'text', text: 'Browser panel closed.' }],
          details: { type: 'browser', action: 'close' }
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
  ): Promise<AgentToolResult<BrowserToolDetails>> {
    if (!devtoolsAction) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: "devtools_action" is required when action="devtools".\n\n${DEVTOOLS_HELP}`
          }
        ],
        details: {
          type: 'browser',
          action: 'devtools',
          error: 'missing devtools_action'
        }
      }
    }

    switch (devtoolsAction) {
      case 'snapshot':
        return snapshotAction()
      case 'screenshot':
        return screenshotAction(devtoolsParams, this.ctx)
      case 'print_to_pdf':
        return printToPdfAction(devtoolsParams, this.ctx)
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
            type: 'browser',
            action: 'devtools',
            devtoolsAction,
            error: 'unknown action'
          }
        }
    }
  }
}

registerBuiltinTool({
  name: 'browser',
  group: 'general',
  defaultEnabled: false,
  getLabel: () => t('tool.browserLabel'),
  getHint: () => t('tool.browserHint'),
  factory: (ctx) => new BrowserTool(ctx),
  presentation: {
    icon: 'Monitor',
    iconColor: '#60a5fa',
    summaryField: 'action'
  }
})
