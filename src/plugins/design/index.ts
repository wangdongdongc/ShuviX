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
      commands: [
        {
          commandId: 'design',
          name: 'Design',
          description: 'Enter interactive design mode',
          template: DESIGN_COMMAND_TEMPLATE,
          requiredTools: ['design']
        }
      ],
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
                ctx.emitEvent(event.sessionId, { type: 'plugin:preview_server_started', url: info.url })
              )
              .catch((err) => ctx.logger.error('startDev failed', err))
            break
          case 'preview:stop':
            manager.stopDev(event.sessionId)
            ctx.emitEvent(event.sessionId, { type: 'plugin:preview_server_stopped' })
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

// ────────────────────── Command template ──────────────────────

const DESIGN_COMMAND_TEMPLATE = `You are now in interactive design mode. Use the \`design\` tool to create and preview React UI components.

## Workflow

1. Choose a template and call \`design\` tool with \`action: "init"\` and \`template\` parameter
2. Use \`write\`/\`edit\` tools to create/modify files under \`.shuvix/design/\`
3. Call \`design\` tool with \`action: "preview"\` to build and open the preview panel (first time starts the dev server; subsequent calls rebuild and refresh)
4. If preview shows build errors, the tool returns detailed error messages — fix the code and call \`preview\` again

## Templates

Choose the most appropriate template based on the user's request:

- **blank**: Minimal skeleton — just App.tsx with "Hello World". Best for fully custom designs or simple experiments.
- **app**: Standard React app with example components and a counter demo (default). Good for general-purpose UI.
- **landing**: Single-page marketing/landing page with Hero, Features, and Footer sections. Best for product pages and promotional sites.
- **dashboard**: Multi-page application with sidebar navigation using React Router. Includes Dashboard, Analytics, and Settings pages. Best for admin panels, data dashboards, and management UIs.

## Technical Stack

- **React + TypeScript**: Function components with Hooks, .tsx/.ts files
- **React Router**: Available for multi-page navigation. Use \`createHashRouter\` + \`RouterProvider\` in index.tsx, \`Outlet\` + \`NavLink\` for layout. Import from \`react-router\`.
- **Tailwind CSS v4**: Utility-first CSS framework, available globally — use className with Tailwind utilities directly (e.g. \`className="flex items-center gap-2 p-4 bg-white rounded-lg shadow"\`)
- **CSS imports**: Supported for custom styles beyond Tailwind
- **Images**: Supported as dataurl inline (svg/png/jpg/gif)
- **Available packages**: React, ReactDOM, React Router, Tailwind CSS — no other npm packages

## Routing (for multi-page apps)

Use hash-based routing (\`createHashRouter\`) — it works without server-side configuration:

\`\`\`tsx
// index.tsx
import { createHashRouter, RouterProvider } from 'react-router'
const router = createHashRouter([
  { path: '/', element: <App />, children: [
    { index: true, element: <Home /> },
    { path: 'about', element: <About /> }
  ]}
])
createRoot(root).render(<RouterProvider router={router} />)

// App.tsx — use Outlet for child routes, NavLink for navigation
import { Outlet, NavLink } from 'react-router'
\`\`\`

## Code Conventions

- Use function components with Hooks
- Use TypeScript for all files
- Prefer Tailwind CSS utility classes over custom CSS
- Split components into separate files under \`components/\`
- Place page-level components under \`pages/\`
- Use relative imports between files

$ARGUMENTS`
