/**
 * externalOpen —— 浏览器面板里 tab 弹窗（window.open / target=_blank）的目标能交给操作系统什么。
 * 纯模块，这里不 mock 任何东西。
 *
 *  - EO-1…18  externalOpenDecision 的裁决表：http(s) 在面板里开（web）、mailto 直接交给系统（open）、
 *    带 attach 类参数的 mailto 与别的应用的协议先问（ask）、指向文件的 / 浏览器内部的 / 解析不了的
 *    一律拒绝（refuse）。交出去的是裁决时的规范化 href —— 被判的就是被打开的 —— 所以期望值一律用
 *    toStrictEqual 整个比，拒绝的结果里连 url 键都不该有。
 *  - EO-19…31 createExternalOpenAsk 的节流：同一时刻至多一个询问，弹着时再来的直接 false（不排队）；
 *    拒绝或询问本身失败之后静默 DECLINE_QUIET_MS（从询问框关掉那一刻起算），允许之后不静默；
 *    返回的函数从不 reject。
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DECLINE_QUIET_MS,
  clipUrl,
  createExternalOpenAsk,
  externalOpenDecision,
  type ExternalOpenDecision
} from '../externalOpen'

type Row = [raw: string, expected: ExternalOpenDecision]

/** 「url 原样」的行：期望的 url 就是输入本身 */
function same(action: 'web' | 'open' | 'ask', raws: string[]): Row[] {
  return raws.map((raw) => [raw, { action, url: raw }])
}

/** 拒绝的行：期望里没有 url 键（toStrictEqual 连这个一起比） */
function refused(reason: 'unparsable' | 'file' | 'internal', raws: string[]): Row[] {
  return raws.map((raw) => [raw, { action: 'refuse', reason }])
}

/**
 * 用例名里显示的输入：JSON 转义（tab、换行、NUL 这类控制字符看得见），C1 控制字符与方向 / 零宽
 * 字符也写成转义 —— 报告里不会有一行被 RLO 倒过来显示
 */
function show(raw: string): string {
  return JSON.stringify(raw).replace(
    /[\x7f-\x9f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** it.each 的表：头一列是用例名里显示的输入，后两列是输入与期望 */
function table(rows: Row[]): Array<[shown: string, raw: string, expected: ExternalOpenDecision]> {
  return rows.map(([raw, expected]) => [show(raw), raw, expected])
}

describe('externalOpenDecision', () => {
  it.each(
    table([
      ['https://example.com/a?b#c', { action: 'web', url: 'https://example.com/a?b#c' }],
      ['HTTP://EXAMPLE.com', { action: 'web', url: 'http://example.com/' }],
      ['https://example.com:443/', { action: 'web', url: 'https://example.com/' }],
      ['https://例え.jp/', { action: 'web', url: 'https://xn--r8jz45g.jp/' }],
      ['http://127.0.0.1:8080', { action: 'web', url: 'http://127.0.0.1:8080/' }]
    ])
  )('EO-1 http(s) → web，url 是规范化后的 href：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table([
      ['https:example.com', { action: 'web', url: 'https://example.com/' }],
      // 运行期的串是 http:\\example.com\a：特殊协议里反斜杠就是斜杠
      ['http:\\\\example.com\\a', { action: 'web', url: 'http://example.com/a' }]
    ])
  )('EO-2 省掉 // 或写成反斜杠的 http(s) 照样按网页解析 → web：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table([
      ...same('open', ['mailto:someone@example.com']),
      ['MAILTO:Someone@Example.com', { action: 'open', url: 'mailto:Someone@Example.com' }],
      ...same('open', ['mailto:x@y.z?subject=hi&body=there']),
      ['mailto:x@y.z?subject=a b', { action: 'open', url: 'mailto:x@y.z?subject=a%20b' }],
      ['mailto:', { action: 'open', url: 'mailto:' }]
    ])
  )('EO-3 mailto: → open，不问（只会起一封草稿）：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      same('ask', [
        'mailto:x@y.z?attach=/etc/passwd',
        'mailto:x@y.z?Attachment=~/.ssh/id_rsa',
        'mailto:x@y.z?ATTACH=/x',
        'mailto:x@y.z?attachments=/x',
        'mailto:x@y.z?subject=hi&attach=/x',
        'mailto:x@y.z?attach',
        'mailto:?attach=/etc/passwd',
        'mailto:x@y.z?subject=hi&Attach%5B%5D=/x'
      ])
    )
  )('EO-4 带 attach 类参数的 mailto → ask，url 原样：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      same('ask', ['mailto:x@y.z?%61ttach=/etc/passwd', 'mailto:x@y.z?%41TTACHMENT=/etc/passwd'])
    )
  )('EO-5 参数名按百分号解码后再认 → ask，url 保持编码：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      same('ask', [
        'mailto:x@y.z?+attach=/x',
        'mailto:x@y.z?%20attach=/x',
        'mailto:x@y.z?%09attach=/x',
        'mailto:x@y.z?%C2%A0attach=/x',
        'mailto:x@y.z?%EF%BB%BFattach=/x'
      ])
    )
  )('EO-6 参数名前的空白（+、%20、%09、NBSP、BOM）不算数 → ask：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      same('open', [
        'mailto:x@y.z?subject=attach',
        'mailto:x@y.z?xattach=1',
        'mailto:x@y.z?%2561ttach=/x',
        'mailto:x@y.z?subject=See%20attached%20file',
        'mailto:attach@example.com'
      ])
    )
  )(
    'EO-7 只认参数位置上的 attach，参数名只解码一次 → open，url 原样：%s',
    (_shown, raw, expected) => {
      expect(externalOpenDecision(raw)).toStrictEqual(expected)
    }
  )

  it.each(
    table(
      same('ask', [
        'mailto:x@y.z?body=a%26attach%3D/etc/passwd',
        'mailto:x@y.z?subject=hi;attach=/etc/passwd',
        'mailto:x@y.z#?attach=/etc/passwd',
        'mailto:x@y.z%3Fattach=/etc/passwd'
      ])
    )
  )(
    'EO-8 按「先解码、后切分」的邮件客户端读出了 attach 参数 → ask，url 原样：%s',
    (_shown, raw, expected) => {
      expect(externalOpenDecision(raw)).toStrictEqual(expected)
    }
  )

  it('EO-8 残缺的 % 转义（mailto:x@y.z?subject=%E0%A4%A）不抛，照常 → open，url 原样', () => {
    const raw = 'mailto:x@y.z?subject=%E0%A4%A'
    let decision: ExternalOpenDecision | undefined
    expect(() => (decision = externalOpenDecision(raw))).not.toThrow()
    expect(decision).toStrictEqual({ action: 'open', url: raw })
  })

  it.each(
    table(
      refused('file', [
        'file:///Applications/Calculator.app',
        'file:///Applications/',
        'FILE:///etc/passwd',
        'file://server/share/x',
        // 运行期的串是 file:\\server\share
        'file:\\\\server\\share'
      ])
    )
  )('EO-9 file: → refuse file，一律拒绝，不问：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      refused('file', [
        'c:/Windows/System32/calc.exe',
        // 运行期的串是 C:\Windows\System32\calc.exe
        'C:\\Windows\\System32\\calc.exe',
        'C:/',
        'z:foo'
      ])
    )
  )(
    'EO-10 单字母协议（Windows 盘符，交给系统就是运行它）→ refuse file：%s',
    (_shown, raw, expected) => {
      expect(externalOpenDecision(raw)).toStrictEqual(expected)
    }
  )

  it('EO-10 边界：两个字母的协议不是盘符 → ask', () => {
    expect(externalOpenDecision('ab:foo')).toStrictEqual({ action: 'ask', url: 'ab:foo' })
  })

  const SHARE_SCHEMES = [
    'smb',
    'cifs',
    'afp',
    'nfs',
    'ftp',
    'ftps',
    'sftp',
    'webdav',
    'webdavs',
    'dav',
    'davs'
  ]
  it.each(
    table(
      refused('file', [
        ...SHARE_SCHEMES.map((scheme) => `${scheme}://host/share/x`),
        'SMB://HOST/share',
        'FTP://x/y'
      ])
    )
  )('EO-11 网络共享协议 → refuse file：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      refused('internal', [
        'about:blank',
        'ABOUT:BLANK',
        'about:srcdoc',
        'blob:http://127.0.0.1:5173/0b8f1f0e-3b8e-4d4a-9f0e-000000000000',
        'data:text/html,hi',
        'javascript:alert(1)',
        'view-source:https://example.com',
        // filesystem: 是浏览器内部的，不是「指向文件」
        'filesystem:http://example.com/temporary/x',
        'chrome://settings',
        'chrome-untrusted://x',
        'chrome-extension://abc/x',
        'devtools://devtools/bundled/inspector.html'
      ])
    )
  )('EO-12 浏览器内部地址（离开页面没有意义）→ refuse internal：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table(
      refused('unparsable', [
        '',
        ' ',
        'not a url',
        'example.com',
        '//example.com',
        '/relative/path',
        'http://',
        'https://exa mple.com',
        'http://[::1',
        '1:foo',
        'c|/Windows/System32/calc.exe',
        // 运行期的串是 \\server\share\x.exe
        '\\\\server\\share\\x.exe'
      ])
    )
  )('EO-13 解析不了的 → refuse unparsable：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table([
      ...same('ask', [
        'zoommtg://zoom.us/join?confno=123',
        'vscode://file/Users/x/.zshrc',
        'tel:+15551234567',
        'slack://open',
        'git+ssh://host/repo',
        'x-apple.systempreferences:com.apple.preference.security',
        'x-probe-custom://Upper'
      ]),
      ['ms-msdt:/id PCWDiagnostic', { action: 'ask', url: 'ms-msdt:/id%20PCWDiagnostic' }],
      ['X-PROBE-CUSTOM://Upper', { action: 'ask', url: 'x-probe-custom://Upper' }],
      ['Zoommtg://Zoom.US/join', { action: 'ask', url: 'zoommtg://Zoom.US/join' }]
    ])
  )('EO-14 别的应用的 URL scheme → ask，url 是规范化后的 href：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table([
      ['ws://example.com', { action: 'ask', url: 'ws://example.com/' }],
      ['wss://example.com', { action: 'ask', url: 'wss://example.com/' }]
    ])
  )('EO-15 ws(s) 不是面板要开的网页 → ask：%s', (_shown, raw, expected) => {
    expect(externalOpenDecision(raw)).toStrictEqual(expected)
  })

  it.each(
    table([
      ['java\tscript:alert(1)', { action: 'refuse', reason: 'internal' }],
      ['java\nscript:alert(1)', { action: 'refuse', reason: 'internal' }],
      [' javascript:alert(1)', { action: 'refuse', reason: 'internal' }],
      ['fi\nle:///etc/passwd', { action: 'refuse', reason: 'file' }],
      ['mai\tlto:x@y.z', { action: 'open', url: 'mailto:x@y.z' }],
      ['mailto:x@y.z?at\ntach=/x', { action: 'ask', url: 'mailto:x@y.z?attach=/x' }],
      [
        'zoom\nmtg://zoom.us/join?confno=1',
        { action: 'ask', url: 'zoommtg://zoom.us/join?confno=1' }
      ],
      ['  zoommtg://x  ', { action: 'ask', url: 'zoommtg://x' }],
      ['\x00https://example.com', { action: 'web', url: 'https://example.com/' }],
      ['zoommtg://x/a b', { action: 'ask', url: 'zoommtg://x/a%20b' }],
      ['zoommtg://x/\u{202E}evil', { action: 'ask', url: 'zoommtg://x/%E2%80%AEevil' }]
    ])
  )(
    'EO-16 tab、换行与首尾控制字符按 URL 解析剥掉之后再判，url 也是剥掉后的：%s',
    (_shown, raw, expected) => {
      expect(externalOpenDecision(raw)).toStrictEqual(expected)
    }
  )

  it('EO-17 2 MB 的 data: 地址照样判 refuse internal，不抛', () => {
    const raw = 'data:text/html,' + 'a'.repeat(2_000_000)
    let decision: ExternalOpenDecision | undefined
    expect(() => (decision = externalOpenDecision(raw))).not.toThrow()
    expect(decision).toStrictEqual({ action: 'refuse', reason: 'internal' })
  })

  it('EO-17 5015 字的自定义协议地址 → ask，url 原样：裁决从不截断地址', () => {
    const raw = 'zoommtg://x/?q=' + 'a'.repeat(5000)
    expect(raw).toHaveLength(5015)
    expect(externalOpenDecision(raw)).toStrictEqual({ action: 'ask', url: raw })
  })

  it('EO-18 clipUrl：不超过 max（默认 300）原样返回，超出截到 max 再补一个 …', () => {
    expect(clipUrl('a'.repeat(300))).toBe('a'.repeat(300))
    expect(clipUrl('a'.repeat(301))).toBe('a'.repeat(300) + '…')
    expect(clipUrl('abcdef', 3)).toBe('abc…')
  })
})

interface Req {
  tab: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 受控的 confirm：每次被调都排一个待答的询问，用例自己决定何时、怎么答 */
function controlled(): {
  confirm: Mock<(request: Req) => Promise<boolean>>
  answers: Array<Deferred<boolean>>
} {
  const answers: Array<Deferred<boolean>> = []
  const confirm = vi.fn((_request: Req) => {
    const answer = deferred<boolean>()
    answers.push(answer)
    return answer.promise
  })
  return { confirm, answers }
}

/** 跑完已排队的微任务再过一轮宏任务 */
function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
}

describe('createExternalOpenAsk', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('EO-19 confirm 答 true → 返回 true；confirm 只调一次，收到的就是那个请求对象', async () => {
    const { confirm, answers } = controlled()
    const ask = createExternalOpenAsk(confirm, () => 0)
    const request = { tab: 'A' }
    const pending = ask(request)
    answers[0].resolve(true)

    await expect(pending).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe(request)
  })

  it('EO-20 confirm 答 false → 返回 false', async () => {
    const { confirm, answers } = controlled()
    const ask = createExternalOpenAsk(confirm, () => 0)
    const pending = ask({ tab: 'A' })
    answers[0].resolve(false)

    await expect(pending).resolves.toBe(false)
  })

  it('EO-21 拒绝后 DECLINE_QUIET_MS 内直接 false、不调 confirm；满 DECLINE_QUIET_MS 再问', async () => {
    const { confirm, answers } = controlled()
    let clock = 1000
    const ask = createExternalOpenAsk(confirm, () => clock)
    const declined = ask({ tab: 'A' })
    answers[0].resolve(false)
    await expect(declined).resolves.toBe(false)

    clock = 1000 + DECLINE_QUIET_MS - 1
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    clock = 1000 + DECLINE_QUIET_MS
    const again = ask({ tab: 'A' })
    await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    answers[1].resolve(true)
    await expect(again).resolves.toBe(true)
  })

  it('EO-22 静默期从询问框关掉那一刻起算，不是从弹出时', async () => {
    const { confirm, answers } = controlled()
    let clock = 0
    const ask = createExternalOpenAsk(confirm, () => clock)
    const pending = ask({ tab: 'A' })

    clock = 60_000
    answers[0].resolve(false)
    await expect(pending).resolves.toBe(false)

    clock = 69_999
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    clock = 70_000
    const again = ask({ tab: 'A' })
    await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    answers[1].resolve(false)
    await expect(again).resolves.toBe(false)
  })

  it('EO-23 允许之后不静默：同一时刻再来照样问', async () => {
    const { confirm, answers } = controlled()
    const ask = createExternalOpenAsk(confirm, () => 0)
    const allowed = ask({ tab: 'A' })
    answers[0].resolve(true)
    await expect(allowed).resolves.toBe(true)

    const again = ask({ tab: 'A' })
    await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    answers[1].resolve(true)
    await expect(again).resolves.toBe(true)
  })

  it('EO-24 询问框弹着时再来的请求直接 false：不排队，也不起静默期', async () => {
    const { confirm, answers } = controlled()
    const ask = createExternalOpenAsk(confirm, () => 0)
    const requestA = { tab: 'A' }
    const requestB = { tab: 'B' }
    const pendingA = ask(requestA)

    // A 还没答就先等 B：B 不该等 A
    await expect(ask(requestB)).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    answers[0].resolve(true)
    await expect(pendingA).resolves.toBe(true)
    await flush()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalledWith(requestB)

    const third = ask({ tab: 'C' })
    await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    answers[1].resolve(false)
    await expect(third).resolves.toBe(false)
  })

  it('EO-25 confirm 返回 rejected promise → 按拒绝处理：返回 false 而不 reject，静默期照起', async () => {
    let clock = 0
    const confirm = vi.fn(
      (_request: Req): Promise<boolean> => Promise.reject(new Error('dialog failed'))
    )
    const ask = createExternalOpenAsk(confirm, () => clock)
    await expect(ask({ tab: 'A' })).resolves.toBe(false)

    clock = 1
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    clock = DECLINE_QUIET_MS
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('EO-26 confirm 同步抛错 → 同 EO-25；静默期过后还能再问，说明「询问中」的锁已放开', async () => {
    let clock = 0
    const confirm = vi.fn((_request: Req): Promise<boolean> => {
      throw new Error('dialog failed')
    })
    const ask = createExternalOpenAsk(confirm, () => clock)
    await expect(ask({ tab: 'A' })).resolves.toBe(false)

    clock = 1
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    clock = DECLINE_QUIET_MS
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['1', 1],
    ["'yes'", 'yes'],
    ['undefined', undefined]
  ] as Array<[label: string, value: unknown]>)(
    'EO-27 confirm 答的不是 true（%s）→ false，并起静默期',
    async (_label, value) => {
      let clock = 0
      const confirm = vi.fn((_request: Req) => Promise.resolve(value as unknown as boolean))
      const ask = createExternalOpenAsk(confirm, () => clock)
      await expect(ask({ tab: 'A' })).resolves.toBe(false)

      clock = 1
      await expect(ask({ tab: 'A' })).resolves.toBe(false)
      expect(confirm).toHaveBeenCalledTimes(1)

      clock = DECLINE_QUIET_MS
      await expect(ask({ tab: 'A' })).resolves.toBe(false)
      expect(confirm).toHaveBeenCalledTimes(2)
    }
  )

  it('EO-28 静默期里被拒的请求不顺延静默期', async () => {
    const { confirm, answers } = controlled()
    let clock = 0
    const ask = createExternalOpenAsk(confirm, () => clock)
    const declined = ask({ tab: 'A' })
    answers[0].resolve(false)
    await expect(declined).resolves.toBe(false)

    for (const at of [5000, 9999]) {
      clock = at
      await expect(ask({ tab: 'A' })).resolves.toBe(false)
    }
    expect(confirm).toHaveBeenCalledTimes(1)

    clock = 10_000
    const again = ask({ tab: 'A' })
    await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    answers[1].resolve(false)
    await expect(again).resolves.toBe(false)
  })

  it('EO-29 不传 now 时按 Date.now() 计时', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const { confirm, answers } = controlled()
    const ask = createExternalOpenAsk(confirm)
    const declined = ask({ tab: 'A' })
    answers[0].resolve(false)
    await expect(declined).resolves.toBe(false)

    vi.setSystemTime(1_000_000 + 9999)
    await expect(ask({ tab: 'A' })).resolves.toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + 10_000)
    const again = ask({ tab: 'A' })
    await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    answers[1].resolve(true)
    await expect(again).resolves.toBe(true)
    vi.useRealTimers()
  })

  it('EO-30 两份节流互不相干：一份刚被拒，另一份照样问', async () => {
    const one = controlled()
    const two = controlled()
    const askOne = createExternalOpenAsk(one.confirm, () => 0)
    const askTwo = createExternalOpenAsk(two.confirm, () => 0)
    const declined = askOne({ tab: 'A' })
    one.answers[0].resolve(false)
    await expect(declined).resolves.toBe(false)
    // 正控制组：被拒的那一份确实在静默期里
    await expect(askOne({ tab: 'A' })).resolves.toBe(false)
    expect(one.confirm).toHaveBeenCalledTimes(1)

    const other = askTwo({ tab: 'B' })
    await flush()
    expect(two.confirm).toHaveBeenCalledTimes(1)
    two.answers[0].resolve(true)
    await expect(other).resolves.toBe(true)
  })

  it('EO-31 DECLINE_QUIET_MS 是 10 秒', () => {
    expect(DECLINE_QUIET_MS).toBe(10_000)
  })
})
