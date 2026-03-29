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
        },
        {
          commandId: 'presentation',
          name: 'Presentation',
          description: 'Create a slide deck presentation',
          template: PRESENTATION_COMMAND_TEMPLATE,
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
- **presentation**: Slide deck using Spectacle (React-based presentation library). Includes example slides with headings, bullet lists, code blocks, and speaker notes. Best for pitch decks, tech talks, and educational presentations.

## Technical Stack

- **React + TypeScript**: Function components with Hooks, .tsx/.ts files
- **React Router**: Available for multi-page navigation. Use \`createHashRouter\` + \`RouterProvider\` in index.tsx, \`Outlet\` + \`NavLink\` for layout. Import from \`react-router\`.
- **Tailwind CSS v4**: Utility-first CSS framework, available globally — use className with Tailwind utilities directly (e.g. \`className="flex items-center gap-2 p-4 bg-white rounded-lg shadow"\`)
- **CSS imports**: Supported for custom styles beyond Tailwind
- **Images**: Supported as dataurl inline (svg/png/jpg/gif)
- **Available packages**: React, ReactDOM, React Router, Spectacle, Tailwind CSS — no other npm packages

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

## Spectacle Presentations (for "presentation" template)

Spectacle is a React component library for slide decks. Key components:

- **Deck**: Root wrapper. Props: \`theme\`, \`template\` (e.g. \`<DefaultTemplate />\`).
- **Slide**: Props: \`backgroundColor\`, \`backgroundImage\`, \`transition\`.
- **Heading/Text**: Props: \`fontSize\` ("h1"-"h3" or number px), \`color\` (theme key or CSS), \`margin\` (CSS string).
- **FlexBox**: Props: \`flexDirection\`, \`justifyContent\`, \`alignItems\`, \`height\`, \`gap\`, \`padding\`, \`margin\`.
- **Grid**: Props: \`gridTemplateColumns\`, \`gridGap\`.
- **Box**: Props: \`backgroundColor\`, \`padding\`, \`margin\`, \`height\`, \`width\`. Use \`style={{ ... }}\` for other CSS.
- **UnorderedList/OrderedList/ListItem**: Lists.
- **Appear**: Animate children in on advance.
- **CodePane**: Props: \`language\`, \`highlightRanges\`.
- **Notes**: Speaker notes (last child of Slide).
- **Image**: Props: \`src\`, \`width\`, \`height\`.
- **DefaultTemplate**: Slide number and progress.

**CRITICAL**: Use \`margin="0 0 24px 0"\` and \`padding="24px"\` (CSS strings). NEVER use shorthand like \`mt\`, \`mb\`, \`px\`, \`py\`, \`p\`, \`m\`, \`sx\`, \`as\` — those are Chakra UI props and will cause blank slides.

## Code Conventions

- Use function components with Hooks
- Use TypeScript for all files
- Prefer Tailwind CSS utility classes over custom CSS
- Split components into separate files under \`components/\`
- Place page-level components under \`pages/\`
- Use relative imports between files

$ARGUMENTS`

// ────────────────────── Presentation command template ──────────────────────

const PRESENTATION_COMMAND_TEMPLATE = `You are now in presentation mode. Use the \`esbuild\` and \`preview\` tools to create and preview a slide deck using Spectacle.

## Workflow

1. Call \`esbuild\` tool with \`action: "init"\` and \`template: "presentation"\` to scaffold the project
2. Use \`write\`/\`edit\` tools to create/modify slides under \`.shuvix/design/\`
3. Call \`esbuild\` tool with \`action: "build"\` — it returns the dev server URL on success
4. Call \`preview\` tool with \`action: "open"\` and the URL from step 3 to open the preview panel
5. If the build fails, fix the code and call \`esbuild\` with \`action: "build"\` again
6. On subsequent builds the preview auto-refreshes via SSE — no need to reopen the panel

## Spectacle Component Reference

Spectacle is a React component library for slide decks. All components are imported from \`spectacle\`.

### CRITICAL: Valid Props

Spectacle components accept ONLY these prop names. Do NOT use shorthand props from other libraries (Chakra UI, MUI, styled-system, etc.).

**Common props for all typography & layout components:**
- \`margin\`: CSS margin string, e.g. \`"0px"\`, \`"0 0 24px 0"\`, \`"16px 0"\`. NOT \`m\`, \`mt\`, \`mb\`, \`mx\`, \`my\`.
- \`padding\`: CSS padding string, e.g. \`"24px"\`, \`"16px 24px"\`. NOT \`p\`, \`pt\`, \`pb\`, \`px\`, \`py\`.
- \`color\`: Theme color key (\`"primary"\`, \`"secondary"\`, \`"tertiary"\`) or CSS color string.
- \`backgroundColor\`: CSS color string or theme key.
- \`fontSize\`: \`"h1"\`, \`"h2"\`, \`"h3"\` or number (px).
- \`fontWeight\`: CSS font-weight (number or string). Use via \`style\` prop.

**NEVER use these props** (they will cause blank/broken slides):
- \`sx\`, \`as\`, \`px\`, \`py\`, \`pt\`, \`pb\`, \`pl\`, \`pr\`, \`mt\`, \`mb\`, \`ml\`, \`mr\`, \`mx\`, \`my\`, \`p\`, \`m\`
- \`fontWeight\` directly on Text/Heading (use \`style={{ fontWeight: 700 }}\` instead)

For custom CSS properties not covered by Spectacle's props, use \`style={{ ... }}\`:
\`\`\`tsx
<Box padding="24px" style={{ borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
\`\`\`

### Core Structure

- **Deck**: Root wrapper. Props: \`theme\`, \`template\` (e.g. \`<DefaultTemplate />\`).
- **Slide**: Single slide. Props: \`backgroundColor\`, \`backgroundImage\`, \`transition\`.
- **DefaultTemplate**: Provides slide number and progress indicator.

### Typography

- **Heading**: Props: \`fontSize\`, \`color\`, \`margin\`.
- **Text**: Props: \`fontSize\`, \`color\`, \`margin\`.
- **Quote / Link / CodeSpan / FitText**: Inline typography variants.

### Layout

- **FlexBox**: Flexbox container. Props: \`flexDirection\`, \`justifyContent\`, \`alignItems\`, \`height\`, \`width\`, \`gap\`, \`padding\`, \`margin\`.
- **Grid**: CSS Grid container. Props: \`gridTemplateColumns\`, \`gridTemplateRows\`, \`gridGap\`.
- **Box**: Generic container. Props: \`backgroundColor\`, \`padding\`, \`margin\`, \`height\`, \`width\`. For other styles use \`style={{ ... }}\`.

### Lists & Tables

- **UnorderedList / OrderedList**: List containers.
- **ListItem**: List item.
- **Table / TableHeader / TableBody / TableRow / TableCell**: Data tables.

### Animation

- **Appear**: Wrap each element that should appear on advance. Example:
  \`\`\`tsx
  <UnorderedList>
    <Appear><ListItem>Point 1</ListItem></Appear>
    <Appear><ListItem>Point 2</ListItem></Appear>
  </UnorderedList>
  \`\`\`

### Code & Markdown

- **CodePane**: Syntax-highlighted code. Props: \`language\`, \`highlightRanges\`.
- **MarkdownSlide**: A full slide from Markdown string.
- **MarkdownSlideSet**: Multiple slides from Markdown separated by \`---\`.

### Other

- **Notes**: Speaker notes (last child of Slide, only visible in presenter mode).
- **Image**: Props: \`src\`, \`width\`, \`height\`.

### Theme & Transitions

\`\`\`tsx
import { Deck, DefaultTemplate, fadeTransition, slideTransition } from 'spectacle'

const theme = {
  colors: { primary: '#1e293b', secondary: '#6366f1', tertiary: '#f8fafc' },
  fonts: { header: '"Inter", sans-serif', text: '"Inter", sans-serif' }
}

<Deck theme={theme} template={<DefaultTemplate />}>
  <Slide transition={fadeTransition}>
    <Heading fontSize="h1" margin="0px">Title</Heading>
  </Slide>
</Deck>
\`\`\`

### Complete Two-Column Slide Example

\`\`\`tsx
<Slide>
  <Heading fontSize="h2" margin="0 0 24px 0">Comparison</Heading>
  <Grid gridTemplateColumns="1fr 1fr" gridGap={24}>
    <Box backgroundColor="#f1f5f9" padding="24px" style={{ borderRadius: '12px' }}>
      <Heading fontSize={28} margin="0 0 12px 0" color="secondary">Option A</Heading>
      <Text fontSize={20} margin="0px">Description here.</Text>
    </Box>
    <Box backgroundColor="#f1f5f9" padding="24px" style={{ borderRadius: '12px' }}>
      <Heading fontSize={28} margin="0 0 12px 0" color="secondary">Option B</Heading>
      <Text fontSize={20} margin="0px">Description here.</Text>
    </Box>
  </Grid>
</Slide>
\`\`\`

## Technical Stack

- **React + TypeScript**: Function components with Hooks, .tsx/.ts files
- **Spectacle**: Slide deck components (imported from \`spectacle\`)
- **Tailwind CSS v4**: Available globally but ONLY for custom wrapper elements (div, span), NOT on Spectacle components
- **Available packages**: React, ReactDOM, Spectacle, Tailwind CSS — no other npm packages

## Code Conventions

- Use function components with Hooks and TypeScript
- All slide content goes in App.tsx (or split into slide components under \`components/\`)
- Use ONLY Spectacle's documented props — when in doubt, use \`style={{ ... }}\` for custom CSS
- Use \`margin\` and \`padding\` (full CSS string), NEVER shorthand like \`mt\`, \`px\`, \`p\`
- Use relative imports between files

$ARGUMENTS`
