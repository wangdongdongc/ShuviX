import type { ShuviXPlugin, PluginContext, PluginContribution } from '../../plugin-api'
import { DesignProjectManager } from './designProjectManager'
import { BundlerService } from './bundlerService'
import { DesignTool } from './designTool'

const designPlugin: ShuviXPlugin = {
  id: 'design',
  name: 'Design Preview',
  version: '1.0.0',

  activate(ctx: PluginContext): PluginContribution {
    const bundler = new BundlerService(ctx.getResourcePath.bind(ctx), ctx.logger)
    const manager = new DesignProjectManager(ctx.getResourcePath.bind(ctx), ctx.logger, bundler)
    const tool = new DesignTool(ctx, manager, bundler)

    return {
      tools: [tool],
      purpose: {
        key: 'ui',
        icon: 'Palette',
        labelKey: 'purposeUI',
        tipKey: 'purposeTipUi',
        i18n: {
          zh: {
            purposeUI: 'UI 设计',
            purposeTipUi: '基于 design 工具生成 React 代码、快速构建、实时预览。'
          },
          en: {
            purposeUI: 'UI Design',
            purposeTipUi:
              'Generate React code with the design tool, quick builds, and live preview.'
          }
        },
        enabledTools: ['bash', 'read', 'write', 'edit', 'ask', 'design']
      },
      onEvent(event) {
        switch (event.type) {
          case 'preview:start':
            manager
              .startDev(event.sessionId, event.workingDir)
              .then((info) =>
                ctx.emitEvent(event.sessionId, { type: 'plugin:panel_open', url: info.url })
              )
              .catch((err) => ctx.logger.error('startDev failed', err))
            break
          case 'preview:stop':
            manager.stopDev(event.sessionId)
            ctx.emitEvent(event.sessionId, { type: 'plugin:panel_close' })
            break
        }
      }
    }
  },

  deactivate() {
    // cleanup would go here
  }
}

export default designPlugin
