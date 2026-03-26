import type { ShuviXPlugin, PluginContext, PluginContribution } from '../../plugin-api'
import { ProjectManager } from './projectManager'
import { BundlerService } from './bundlerService'
import { EsbuildTool } from './esbuildTool'

const esbuildPlugin: ShuviXPlugin = {
  id: 'esbuild',
  name: 'Esbuild Preview',
  version: '1.0.0',

  activate(ctx: PluginContext): PluginContribution {
    const bundler = new BundlerService(ctx.getResourcePath.bind(ctx), ctx.logger)
    const manager = new ProjectManager(ctx.getResourcePath.bind(ctx), ctx.logger, bundler)
    const tool = new EsbuildTool(ctx, manager, bundler)

    return {
      tools: [tool],
      commands: [
        {
          commandId: 'design',
          name: 'Design',
          description: 'Enter interactive design mode',
          template: DESIGN_COMMAND_TEMPLATE,
          requiredTools: ['esbuild', 'preview']
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
            purposeTipUi: '基于 esbuild + preview 工具生成 React 代码、快速构建、实时预览。'
          },
          en: {
            purposeUI: 'UI Design',
            purposeTipUi:
              'Generate React code with esbuild + preview tools, quick builds, and live preview.'
          }
        },
        enabledTools: ['bash', 'read', 'write', 'edit', 'ask', 'esbuild', 'preview']
      },
      onEvent(event) {
        switch (event.type) {
          case 'preview:start':
            manager
              .startDev(event.sessionId, event.workingDir)
              .then((info) =>
                ctx.emitEvent(event.sessionId, {
                  type: 'plugin:preview_server_started',
                  url: info.url
                })
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

export default esbuildPlugin

// ────────────────────── Command template ──────────────────────

const DESIGN_COMMAND_TEMPLATE = `You are now in interactive design mode. Use the \`esbuild\` and \`preview\` tools together to create and preview React UI components.

## Workflow

1. Call \`esbuild\` tool with \`action: "init"\` and a \`template\` to scaffold the project
2. Use \`write\`/\`edit\` tools to create/modify files under \`.shuvix/design/\`
3. Call \`esbuild\` tool with \`action: "build"\` — it returns the dev server URL on success
4. Call \`preview\` tool with \`action: "open"\` and the URL from step 3 to open the preview panel
5. If the build fails, fix the code and call \`esbuild\` with \`action: "build"\` again
6. On subsequent builds the preview auto-refreshes via SSE — no need to reopen the panel

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
