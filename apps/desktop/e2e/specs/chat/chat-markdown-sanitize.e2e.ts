/**
 * 裸 HTML 白名单闸的**另一半** —— 单测断不了的那半。
 *
 * `rehypeSanitizeRawHtml.test.ts` 证的是「hast 树上没有那个节点」。树是干净的，不等于
 * 页面是安全的：脚本执不执行、遮罩盖不盖得住、`<style>` 进不进 document.styleSheets，
 * 只有**真 Chromium + 真 react-markdown + 真渲染进程**答得了。这个文件就问这四句：
 *
 *   1. 一条都没执行（而 `window.api` 那面特权面确实就在旁边 —— 见 `apiTerminal` 的非空证）；
 *   2. 没有任何东西盖住对话（tailwind 原子类与 inline style 是同一块遮罩）；
 *   3. 没有全局样式表被注进来；
 *   4. 正常排版过了 hast→React 这一道还活着 —— 闸产出一棵合法但 React 渲染不对的树，
 *      前三条全绿，只有这一条红。
 *
 * 模型侧由 `harness/fakeProvider` 脚本化（隔离实例没有 API Key）。一次 launchApp，四轮对话。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { createProject, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import { chatPane, sidebarPane, type BubbleMarkup, type ChatPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const SESSION = 'markdown-sanitize'

/** 页内留痕的那一句 —— 每条载荷各写一个 id，绿了说明**一条都没跑** */
const pwn = (id: string): string => `window.__PWNED__ = (window.__PWNED__||[]).concat('${id}')`

/** 块之间必须留空行，否则 markdown 把它们并成一段（表格的行内部则只能用单换行） */
const doc = (...blocks: string[]): string => blocks.join('\n\n')

const EXEC_PAYLOAD = doc(
  'MARK-EXEC-BEGIN',
  `<script>${pwn('script')}</script>`,
  `<img src=x onerror="${pwn('img')}">`,
  `<svg><script>${pwn('svg')}</script></svg>`,
  `<iframe srcdoc="&lt;script&gt;parent.__PWNED__ = (parent.__PWNED__||[]).concat('iframe')&lt;/script&gt;"></iframe>`,
  `<details ontoggle="${pwn('toggle')}"><summary>toggle me</summary>details body</details>`,
  `<noscript><img src=x onerror="${pwn('noscript')}"></noscript>`,
  `<a href="javascript:${pwn('href')}">jslink</a>`,
  'MARK-EXEC-END'
)

const OVERLAY_PAYLOAD = doc(
  'MARK-OVERLAY',
  '<div class="fixed inset-0 z-50 bg-black">tailwind overlay</div>',
  '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000">styled overlay</div>'
)

const STYLE_PAYLOAD = doc(
  'MARK-STYLE',
  '<style>.markdown-body{display:none}body{outline:3px solid red}</style>',
  '<link rel="stylesheet" href="https://evil.example/x.css">'
)

const HAPPY_PAYLOAD = doc(
  'MARK-HAPPY',
  '| left | mid | right |\n|:--|:-:|--:|\n| 1 | 2 | 3 |',
  '- [x] shipped\n- [ ] pending',
  'with a footnote[^n]',
  '```js\nconst answer = 42\n```',
  'inline $x^2$ and a root $\\sqrt{y}$',
  '$$\nE = mc^2\n$$',
  'autolink https://example.com/p here',
  '<details><summary>more</summary>\n\nhidden **body**\n\n</details>',
  'press <kbd>Ctrl</kbd> and read H<sub>2</sub>O',
  '[^n]: the note'
)

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane

/** 发一轮并等气泡真的画上去 —— `waitIdle()` 返回时它还没上屏，中间这一手不能省 */
const turn = async (payload: string, marker: string): Promise<BubbleMarkup> => {
  provider.reset()
  provider.script({ text: payload, usage: { prompt: 90, completion: 20 } })
  await chat.typeAndSend(`render ${marker}`)
  await chat.waitIdle()
  return chat.waitBubbleMarkup(marker)
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const project = await createProject(app.main, { name: 'SanitizeProj', path: app.home })
  await app.main.eval(
    `window.api.session.create(${JSON.stringify({ title: SESSION, projectId: project.id })})
      .then((s) => s.id)`
  )

  chat = chatPane(app.main)
  const sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  expect(await sidebar.openSession(SESSION)).toBe(true)
  await chat.ready()
}, 120_000)

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('裸 HTML 只允许变成排版', () => {
  it('一条脚本都没执行，而特权面就在旁边', async () => {
    const shot = await turn(EXEC_PAYLOAD, 'MARK-EXEC-BEGIN')
    expect(shot.text).toContain('MARK-EXEC-END')
    // 非空证之一：载荷确实被**当作标记**解析了（rehype-raw 在位），不是原样转义成文字 ——
    // 否则这一整条用例只是在证明「把 HTML 显示成字符串很安全」
    expect(shot.text).not.toContain('<script>')
    expect(shot.tags).toContain('details')
    expect(shot.text).toContain('details body')

    // `ontoggle` 是开合时才触发的，不真点开就永远绿
    await chat.openBubbleDetails()
    // `javascript:` 链接：href 已被剥光，点它只能什么都不发生
    expect(await chat.clickBubbleLink('jslink')).toBe('')

    const marks = await chat.pwnMarks()
    expect(marks.hits).toEqual([])
    // 非空证，与 hits 同一次 eval：特权面确实在这个页面上，只是够不着
    expect(marks.apiTerminal).toBe('object')

    expect(shot.executable).toBe(0)
    expect(shot.svgScripts).toBe(0)
    // 气泡里合法地有 lucide 的 svg（代码块复制按钮），所以数的是 `svg script` 而不是 svg
    expect(shot.hrefs.every((h) => !h.toLowerCase().includes('javascript'))).toBe(true)
  }, 120_000)

  it('没有任何东西盖住对话', async () => {
    const shot = await turn(OVERLAY_PAYLOAD, 'MARK-OVERLAY')
    // 两块遮罩的**文字**要留着：证明闸剥的是能力，不是内容
    expect(shot.text).toContain('tailwind overlay')
    expect(shot.text).toContain('styled overlay')
    expect(shot.fixed).toBe(0)

    const win = await chat.windowMarkup()
    expect(win.composerHitTag).toBe('textarea')
    expect(win.composerReachable).toBe(true)
  }, 120_000)

  it('没有全局样式表被注进来', async () => {
    const before = await chat.windowMarkup()
    const shot = await turn(STYLE_PAYLOAD, 'MARK-STYLE')

    const after = await chat.windowMarkup()
    expect(after.styleSheets).toBe(before.styleSheets)
    expect(after.bodyOutlineWidth).toBe('0px')
    expect(shot.executable).toBe(0)
    expect(shot.tags).not.toContain('style')
    expect(shot.tags).not.toContain('link')
  }, 120_000)

  it('正常排版过了 hast→React 这一道还在屏上', async () => {
    const shot = await turn(HAPPY_PAYLOAD, 'MARK-HAPPY')

    for (const tag of [
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'ul',
      'li',
      'input',
      'sup',
      'section',
      'pre',
      'code',
      'a',
      'details',
      'summary',
      'kbd',
      'sub',
      'math',
      'annotation',
      'path'
    ]) {
      expect(shot.tags, `缺了 <${tag}>`).toContain(tag)
    }

    expect(shot.text).toContain('the note')
    expect(shot.text).toContain('const answer = 42')
    expect(shot.text).toContain('hidden body')
    expect(shot.hrefs).toContain('https://example.com/p')
    // 排版活着的同时，前三条的判据一条都不能松
    expect(shot.executable).toBe(0)
    expect(shot.svgScripts).toBe(0)
    expect(shot.fixed).toBe(0)
  }, 120_000)
})
