/**
 * 小组件可用的库（widgetLibs.json、resources/bundler/vendor）—— 一条真的链路：点开组件卡片 → 真的 esbuild-wasm 按仓库里
 * vendor 目录打包（lucide-react、chart.js 打进 bundle；three 留作外部模块）→ 页面骨架的 import map 把 `three` /
 * `three/addons/…` 指到组件服务的 `/w/<id>/lib/three@<version>/…`（widgetLibFiles.ts，长缓存、gzip）→ 真的 Chromium
 * 按 import map 拉模块图（three.module.js 再相对 import three.core.js）→ WebGL 画一帧。单测里没有的就是这些：真的 import
 * map 解析、模块脚本的请求带上组件令牌、浏览器真的协商 gzip、vendor 里 served 库的相对 import 闭包在运行时取得到。
 *
 *   E-1 种一个组件（lucide 的 Plus、注册了的 chart.js 柱状图、`* as THREE` + OrbitControls 画一帧，结果写到
 *       window.__probe、body[data-ready]），开在 Widget 面板里，接上它的 iframe target：
 *       1. 30s 内 ready（模块图有一个 404 / import map 不对，bundle 根本不跑）
 *       2. svg.lucide-plus 在；revision = 187、OrbitControls 是函数；图表宽度 > 0；[data-three] 里有 canvas；webgl = true
 *       3. 资源计时里 three.module.js、three.core.js、OrbitControls.js 都是 200，three.module.js 是压过的（gzip）；
 *          没有 /lib/lucide-react@、/lib/chart.js@ 的请求（它们打进了 bundle）
 *       4. bundle.js 里有 `from"three"`，没有 `Three.js Authors`（three 没被打进来）
 *       5. 另开一条 CDP 连接收事件（Runtime / Log），iframe 里 location.reload() 再等 ready：没有异常、没有 error 级的
 *          日志 / console（特别是没有 Failed to load module script）
 *   E-2 同一个组件经 web 客户端打开（网络服务开着，应用自己的浏览器里开 `http://127.0.0.1:<port>/`，桌面布局的 Widget
 *       面板）：iframe 是沙箱（不透明源），模块脚本成了跨源请求，要转发过来的 `access-control-allow-origin: *`，import map
 *       的地址经 widgetProxy 落在网络服务的源上 —— 断 E-1 的第 1、2、4 步。不断资源计时（不透明源的文档里每个资源都是
 *       跨源的，没有 Timing-Allow-Origin 时 Chromium 报 0）
 *
 * 组件页面在 Widget 面板的跨源 iframe 里，自己有一个 CDP target（`iframe`）；页面里的 DOM 是这个 spec 自己写的组件，
 * 读它不经 pages.ts（与 widget-theme.e2e.ts 同一种做法）。harness 的 CDP 客户端丢掉事件，所以第 5 步自己连一条。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, listTargets, until, type CdpClient } from '../../harness/cdp'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import { openWebClient, type WebClientHandle } from '../../harness/networkFixtures'
import { rightPanelPane, widgetPanelPane } from '../../harness/pages'

const WIDGET = 'libs-probe'
const THREE_BASE = `/w/${WIDGET}/lib/three@0.187.0/`

/** 组件界面：每个库各用一下，结果写到 window.__probe */
const SCREEN_TSX = `import { createRoot } from 'react-dom/client'
import { useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'
import { Chart, BarController, BarElement, CategoryScale, LinearScale } from 'chart.js'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

Chart.register(BarController, BarElement, CategoryScale, LinearScale)

const w = window as unknown as Record<string, unknown>

function App() {
  const chartRef = useRef<HTMLCanvasElement>(null)
  const threeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const chart = new Chart(chartRef.current!, {
      type: 'bar',
      data: { labels: ['a', 'b', 'c'], datasets: [{ data: [3, 1, 2] }] },
      options: { animation: false, responsive: false }
    })
    let webgl = false
    try {
      const renderer = new THREE.WebGLRenderer()
      renderer.setSize(160, 100)
      threeRef.current!.appendChild(renderer.domElement)
      const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 100)
      camera.position.z = 4
      const scene = new THREE.Scene()
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3366ff })))
      const controls = new OrbitControls(camera, renderer.domElement)
      controls.update()
      renderer.render(scene, camera)
      webgl = true
    } catch (e) {
      w.__webglError = String(e)
    }
    w.__probe = { revision: THREE.REVISION, orbit: typeof OrbitControls, chartWidth: chart.width, webgl }
    document.body.dataset.ready = '1'
  }, [])
  return (
    <div className="p-4">
      <Plus />
      <canvas data-chart="" ref={chartRef} width={240} height={120} />
      <div data-three="" ref={threeRef} />
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
`

let app: E2EApp
let frame: CdpClient | null = null
let recorder: EventRecorder | null = null
let web: WebClientHandle | null = null
let webFrame: CdpClient | null = null

function seedWidget(home: string): void {
  const dir = join(home, '.shuvix', 'widgets', WIDGET)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      { id: WIDGET, name: 'Libs probe', description: '', entryFile: 'index.tsx', createdAt: 1000 },
      null,
      2
    ) + '\n'
  )
  writeFileSync(join(dir, 'index.tsx'), SCREEN_TSX)
}

// ─── 第 5 步：自己的一条 CDP 连接，收事件 ─────────

interface CdpEvent {
  method: string
  params: Record<string, unknown>
}

interface EventRecorder {
  events: CdpEvent[]
  send(method: string): Promise<void>
  close(): void
}

/** 连同一个 target 的第二条 CDP 连接：只收事件（harness 的客户端把没有 id 的消息丢掉） */
function recordEvents(wsUrl: string): Promise<EventRecorder> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const events: CdpEvent[] = []
    const pending = new Map<number, (error: unknown) => void>()
    let nextId = 0
    ws.onmessage = (message) => {
      const msg = JSON.parse(String(message.data)) as {
        id?: number
        error?: unknown
        method?: string
        params?: Record<string, unknown>
      }
      if (msg.id !== undefined) {
        pending.get(msg.id)?.(msg.error)
        pending.delete(msg.id)
      } else if (msg.method) {
        events.push({ method: msg.method, params: msg.params ?? {} })
      }
    }
    ws.onerror = () => reject(new Error(`CDP connect failed: ${wsUrl}`))
    ws.onopen = () =>
      resolve({
        events,
        send: (method) =>
          new Promise<void>((done, fail) => {
            const id = ++nextId
            pending.set(id, (error) => (error ? fail(new Error(JSON.stringify(error))) : done()))
            ws.send(JSON.stringify({ id, method, params: {} }))
          }),
        close: () => ws.close()
      })
  })
}

/** 事件里的错误：异常、error 级的日志、console.error / assert */
function errorsIn(events: CdpEvent[]): string[] {
  const out: string[] = []
  for (const { method, params } of events) {
    if (method === 'Runtime.exceptionThrown') {
      out.push(`exception: ${JSON.stringify(params.exceptionDetails).slice(0, 400)}`)
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry as { level?: string; text?: string; url?: string }
      if (entry.level === 'error') out.push(`log: ${entry.text} (${entry.url ?? ''})`)
    } else if (method === 'Runtime.consoleAPICalled') {
      if (params.type === 'error' || params.type === 'assert') {
        out.push(`console.${params.type}: ${JSON.stringify(params.args).slice(0, 400)}`)
      }
    }
  }
  return out
}

interface Probe {
  revision: string
  orbit: string
  chartWidth: number
  webgl: boolean
}

interface ResourceEntry {
  name: string
  responseStatus: number
  encodedBodySize: number
  decodedBodySize: number
}

const resources = (): Promise<ResourceEntry[]> =>
  frame!.eval<ResourceEntry[]>(
    `performance.getEntriesByType('resource').map((e) => ({ name: e.name, responseStatus: e.responseStatus, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize }))`
  )

beforeAll(async () => {
  app = await launchApp()
  seedWidget(app.home)

  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const right = rightPanelPane(app.main)
  await right.open()
  await right.activateWidgetTab()
  const panel = widgetPanelPane(app.main)
  await panel.reload()
  await until(async () => (await panel.cardIds()).includes(WIDGET) || null, 'the widget card')
}, 120_000)

afterAll(async () => {
  recorder?.close()
  frame?.close()
  webFrame?.close()
  if (web) await web.close().catch(() => undefined)
  if (app) {
    await app.main.eval(`window.api.network.setEnabled(false)`).catch(() => undefined)
  }
  await app?.stop()
})

describe('widget libraries', () => {
  it('E-1 bundled libraries and the served three load from the vendor and run in the panel', async () => {
    const panel = widgetPanelPane(app.main)
    await panel.clickCard(WIDGET)
    await until(async () => (await panel.foregroundApp()) === WIDGET || null, 'opened in panel')
    await until(() => panel.frameReady(WIDGET), 'the widget iframe')
    const target = await until(
      async () =>
        (await listTargets(app.port)).find(
          (t) => t.type === 'iframe' && t.url.includes(`/w/${WIDGET}/`)
        ),
      'the widget iframe target',
      30_000
    )
    frame = await connect(target.webSocketDebuggerUrl)

    // 1. 模块图整个取到了（three 有一个文件 404，bundle 就不跑）
    await until(
      () => frame!.eval<boolean>(`document.body?.dataset.ready === '1'`),
      'the widget screen ran (body[data-ready])',
      30_000
    )

    // 2. 每个库都真的用上了
    expect(await frame.eval<boolean>(`!!document.querySelector('svg.lucide-plus')`)).toBe(true)
    const probe = await frame.eval<Probe>('window.__probe')
    const webglError = await frame.eval<string | null>('window.__webglError ?? null')
    expect(probe.revision).toBe('187')
    expect(probe.orbit).toBe('function')
    expect(probe.chartWidth).toBeGreaterThan(0)
    expect(await frame.eval<boolean>(`!!document.querySelector('[data-three] canvas')`)).toBe(true)
    expect(probe.webgl, `WebGL failed: ${webglError}`).toBe(true)

    // 3. three 的文件经 import map 从组件服务来（200，压过的）；打进 bundle 的库没有单独的请求
    const entries = await resources()
    const entry = (path: string): ResourceEntry | undefined =>
      entries.find((e) => new URL(e.name).pathname === path)
    for (const file of [
      'build/three.module.js',
      'build/three.core.js',
      'examples/jsm/controls/OrbitControls.js'
    ]) {
      const e = entry(THREE_BASE + file)
      expect(e, `${file} in ${JSON.stringify(entries.map((x) => x.name))}`).toBeDefined()
      expect(e!.responseStatus, file).toBe(200)
    }
    const threeModule = entry(`${THREE_BASE}build/three.module.js`)!
    expect(threeModule.encodedBodySize).toBeGreaterThan(0)
    expect(threeModule.encodedBodySize).toBeLessThan(threeModule.decodedBodySize)
    const bundledRequests = entries.filter((e) =>
      /\/lib\/(lucide-react|chart\.js)@/.test(new URL(e.name).pathname)
    )
    expect(bundledRequests).toEqual([])

    // 4. three 留作外部模块，没打进 bundle
    const bundle = await frame.eval<string>(`fetch('bundle.js').then((r) => r.text())`)
    expect(bundle).toContain('from"three"')
    expect(bundle).not.toContain('Three.js Authors')

    // 5. 重新加载一遍，收着事件：没有异常、没有 error 级的日志
    recorder = await recordEvents(target.webSocketDebuggerUrl)
    await recorder.send('Runtime.enable')
    await recorder.send('Log.enable')
    await frame.eval(`(window.__beforeReload = true, setTimeout(() => location.reload(), 0), true)`)
    await until(
      () => frame!.eval<boolean>(`!window.__beforeReload && document.body?.dataset.ready === '1'`),
      'the widget screen ran again after reload',
      30_000
    )
    expect((await frame.eval<Probe>('window.__probe')).webgl).toBe(true)
    // 晚到的日志（加载失败的资源在 load 之后才报）也收进来
    await new Promise((r) => setTimeout(r, 500))
    expect(
      recorder.events.some((e) => e.method === 'Runtime.executionContextCreated'),
      'the recorder saw the reloaded page'
    ).toBe(true)
    expect(errorsIn(recorder.events)).toEqual([])
  })

  it('E-2 the same widget through the web client: a sandboxed iframe loads three through the network server', async () => {
    let port = await freePort()
    while (port === 7766) port = await freePort()
    await app.main.eval(`window.api.network.setPort(${JSON.stringify(port)})`)
    const status = await app.main.eval<{ listening: boolean }>(
      `window.api.network.setEnabled(true)`
    )
    expect(status.listening).toBe(true)
    web = await openWebClient(app, port)
    const page = web.page

    await until(
      () => page.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
      'the right panel toggle in the web client'
    )
    const right = rightPanelPane(page)
    await right.open()
    await right.activateWidgetTab()
    const panel = widgetPanelPane(page)
    await until(async () => (await panel.cardIds()).includes(WIDGET) || null, 'the widget card')
    await panel.clickCard(WIDGET)
    await until(async () => (await panel.foregroundApp()) === WIDGET || null, 'opened in panel')
    const frameUrl = `http://127.0.0.1:${port}/w/${WIDGET}/`
    const target = await until(
      async () =>
        (await listTargets(app.port)).find((t) => t.type === 'iframe' && t.url === frameUrl),
      'the widget iframe target in the web client',
      30_000
    )
    webFrame = await connect(target.webSocketDebuggerUrl)
    const inside = webFrame
    // 沙箱：不透明源
    expect(await inside.eval<string>('window.origin')).toBe('null')

    // 1. 模块图经网络服务整个取到了
    await until(
      () => inside.eval<boolean>(`document.body?.dataset.ready === '1'`),
      'the widget screen ran in the web client (body[data-ready])',
      30_000
    )

    // 2. 每个库都真的用上了
    expect(await inside.eval<boolean>(`!!document.querySelector('svg.lucide-plus')`)).toBe(true)
    const probe = await inside.eval<Probe>('window.__probe')
    const webglError = await inside.eval<string | null>('window.__webglError ?? null')
    expect(probe.revision).toBe('187')
    expect(probe.orbit).toBe('function')
    expect(probe.chartWidth).toBeGreaterThan(0)
    expect(await inside.eval<boolean>(`!!document.querySelector('[data-three] canvas')`)).toBe(true)
    expect(probe.webgl, `WebGL failed: ${webglError}`).toBe(true)

    // 4. 经网络服务拿到的 bundle 也是 three 外置的那一份
    const bundle = await inside.eval<string>(`fetch('bundle.js').then((r) => r.text())`)
    expect(bundle).toContain('from"three"')
    expect(bundle).not.toContain('Three.js Authors')
  }, 120_000)
})
