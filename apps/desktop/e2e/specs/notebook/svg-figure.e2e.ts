/**
 * 笔记本 live preview 里的 ```svg 图 —— 只钉**真实浏览器才有**的那两件事。
 *
 * 揭示（光标进出围栏）、画/不画的判定、净化档位都在单测里
 * （packages/atomic-editor/src/__tests__/fenced-svg.test.tsx，happy-dom）。留在这里的
 * 是那份用例结构上够不着的两样：
 *
 *  1. **级联**。`fill="var(--viz-1)"` 这条写法成立的前提是「图与界面之间没有 shadow DOM，
 *     令牌在编辑器里与在聊天里同样解析」—— 而那正是「不给图铺白卡片」这个决定的地基
 *     （见 816de4c2）。happy-dom 不做级联，单测里这条一个字都测不出来。
 *  2. **布局**。图没有 width/height，只有 viewBox，撑满容器就是整体放大；40rem 的上限
 *     是为此设的。happy-dom 的 getBoundingClientRect 全是 0，尺寸只能在真窗口里量。
 *
 * 选择器全部走 `harness/pages.ts` 的 `svgFigurePane` / `sidebarPane`。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { isMainPage, listTargets, until } from '../../harness/cdp'
import { createProject } from '../../harness/seed'
import { hexToRgb, sidebarPane, svgFigurePane, type SvgFigurePane } from '../../harness/pages'

let app: E2EApp
let figure: SvgFigurePane

/** 笔记文件名即会话标题（sessionService 取 basename） */
const NOTE_FILE = 'figure-note.md'

/**
 * 一张按提示片段的规矩画的图：**只有 viewBox**（没有 width/height），颜色全部取自
 * `--viz-*` 令牌，标注用 `font-size="11"` 的 `<text>` —— 后者正是上限没了时最先出丑的
 * 东西（320 单位的图拉到整屏宽，11 号字变成巨幅标题）。
 */
const NOTE = [
  '# Figure note',
  '',
  '```svg',
  '<svg viewBox="0 0 320 200">',
  '  <rect x="10" y="10" width="300" height="180" fill="var(--viz-1)"/>',
  '  <text x="24" y="44" font-size="11" fill="var(--viz-8)">label</text>',
  '</svg>',
  '```',
  '',
  'tail.',
  ''
].join('\n')

/** 图的宽度上限（inline-preview.css：`max-width: min(100%, 40rem)`） */
const CAP_REM = 40

/**
 * `--viz-1` 在 themes.css 里的两档取值（`light-dark(浅, 深)`）。
 * 写死是刻意的：这一条要钉的就是「令牌真的解析成了那个颜色」，读回来是别的（黑色 =
 * var() 失效后的继承值、或某人重排了 --viz-1..8）都必须红。
 */
const VIZ_1 = { light: '#2a78d6', dark: '#3987e5' }

/**
 * 第二条 CDP 会话 —— 本仓的 CdpClient 只封了 `Runtime.evaluate`，而
 * `Emulation.setDeviceMetricsOverride` 在会话断开时会被自动撤销，所以这条 ws 必须一直
 * 开着量完再关。用模拟视口而不是真去放大窗口：上限是否生效不该取决于跑测试的那块屏幕。
 */
interface RawCdpSession {
  send(method: string, params: Record<string, unknown>): Promise<void>
  close(): void
}

async function openRawSession(port: number): Promise<RawCdpSession> {
  const target = (await listTargets(port)).find((t) => isMainPage(t))
  if (!target) throw new Error('no main page target for the emulation session')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map<number, { ok: () => void; bad: (e: Error) => void }>()
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; error?: unknown }
    if (!msg.id) return
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.bad(new Error(JSON.stringify(msg.error)))
    else slot.ok()
  }
  return new Promise<RawCdpSession>((resolve, reject) => {
    ws.onopen = () =>
      resolve({
        send: (method, params) =>
          new Promise<void>((ok, bad) => {
            const id = ++nextId
            pending.set(id, { ok, bad })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close()
      })
    ws.onerror = () => reject(new Error('emulation CDP session failed'))
  })
}

beforeAll(async () => {
  app = await launchApp()
  figure = svgFigurePane(app.main)
  const projDir = join(app.home, 'proj-svg-figure')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, NOTE_FILE), NOTE)
  const project = await createProject(app.main, { name: 'SvgFigureProj', path: projDir })
  await app.main.eval(
    `window.api.session.create(${JSON.stringify({
      projectId: project.id,
      notebookPath: join(projDir, NOTE_FILE)
    })})`
  )
  // 经 IPC 建的会话要等渲染端把列表拉回来，行才存在（侧栏靠 session.listChanged 广播刷新）
  const sidebar = sidebarPane(app.main)
  await until(
    () => sidebar.titles().then((titles) => titles.includes(NOTE_FILE)),
    `sidebar row "${NOTE_FILE}"`
  )
  expect(await sidebar.openSession(NOTE_FILE)).toBe(true)
  await figure.waitFigure()
})
afterAll(async () => {
  await app.stop()
})

describe('笔记本里的 ```svg 图', () => {
  it('SVG-E1 fill="var(--viz-1)" 在编辑器里真的解析成 themes.css 里那个颜色', async () => {
    // 红了说明「编辑器与聊天之间没有 shadow DOM、令牌两处同样解析」这个前提塌了 ——
    // 而那是「一张手写图不铺白卡片、直接落在编辑器底色上」整个决定的地基。单测一条都
    // 不会跟着红（happy-dom 不做级联），所以这条只能长在这儿。
    const { rectFill } = await figure.shot()

    // 与宿主自己解析出来的同一个令牌逐字节一致 —— 图里的颜色不是碰巧对上的另一个值
    expect(rectFill).toBe(await figure.tokenColor('--viz-1'))
    // 且确实是 themes.css 那两档之一（黑色 = var() 失效后的继承值，必须红）
    expect([hexToRgb(VIZ_1.light), hexToRgb(VIZ_1.dark)]).toContain(rectFill)
  })

  it('SVG-E2 宽窗口里图封顶 40rem，且外框装得下它（没被 overflow:hidden 切掉）', async () => {
    // 两个方向的失败都要挡住：上限**没了** → 320 单位的图按容器宽整体放大，`font-size="11"`
    // 的标注变成巨幅字（聊天里那张图与笔记里这张不再是同一张）；上限**过紧**或外框算错 →
    // 图被裁掉一截，而 overflow 是 hidden，连滚动条都不会出现来告诉你少看了东西。
    const raw = await openRawSession(app.port)
    try {
      await raw.send('Emulation.setDeviceMetricsOverride', {
        width: 1600,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false
      })

      // 等重排落定，同时**这一等本身就是前提**：外框比上限宽，上限才谈得上生效。
      // 缺了它，窗口若偏窄这条用例会一路绿着什么也没测。
      const shot = await until(async () => {
        const s = await figure.shot()
        return s.frame.width > CAP_REM * s.rootFontSize ? s : null
      }, 'notebook figure frame wider than the 40rem cap')

      const cap = CAP_REM * shot.rootFontSize
      expect(shot.svg.width).toBeGreaterThan(0)
      expect(shot.svg.width).toBeLessThanOrEqual(cap + 0.5)

      // 宽高比照 viewBox（320×200）走 —— height 仍是 auto，没被别的规则压扁
      expect(shot.svg.height).toBeCloseTo((shot.svg.width * 200) / 320, 0)

      // 四条边都在外框内容盒里：这才是「没被切掉」
      expect(shot.svg.left).toBeGreaterThanOrEqual(shot.frame.left - 0.5)
      expect(shot.svg.right).toBeLessThanOrEqual(shot.frame.right + 0.5)
      expect(shot.svg.top).toBeGreaterThanOrEqual(shot.frame.top - 0.5)
      expect(shot.svg.bottom).toBeLessThanOrEqual(shot.frame.bottom + 0.5)
    } finally {
      await raw.send('Emulation.clearDeviceMetricsOverride', {})
      raw.close()
    }
  })
})
