/**
 * 网络客户端（远程访问）能让内置浏览器打开、截图的地址（shared/browserRemoteUrls.ts）—— 只认 http(s) 网页、
 * `about:blank` 与认识的 `shuvix://` 内部页面；`file:` 页加上截图就是一次绕过 files scope 的本地文件读取。
 *
 *   RU-1  http / https：大小写不同、回环地址、IPv6、带账号密码、两端空白、`https:` 后面少了 `//` 都认
 *   RU-2  about:blank 只认这一个写法（大小写、两端空白不计）；带 # / ?、别的 about: 页、空的 about: 不认
 *   RU-3  shuvix://：认识的页名（大小写、结尾的 `/`、带 ? / #）认；不认识的页名、没有页名、少了 `//`、多一段
 *         路径、`..`、换行后面藏一个 file: 的都不认
 *   RU-4  别的协议一律不认：file:（大小写、localhost 主机、只有协议）、view-source:（含包着 file: 的）、data:、
 *         blob:、filesystem:、chrome:、chrome-extension:、devtools:、javascript:、ftp:、ws:
 *   RU-5  不是绝对地址的不认：空串、只有空白、裸域名、`//host`、绝对 / ~ 路径、没有主机的 http://、
 *         `localhost:3000`（它的「协议」是主机名）、Windows 盘符路径
 *   RU-6  藏在前导空白 / 控制字符 / 换行后面的 file: 一样不认（URL 解析会剥掉它们，剥完还是 file:）
 *   RU-7  不是字符串的不认、也不抛（含 URL 对象、带 toString 的对象、装着网址的数组）
 *   RU-8  错误码钉死 `remote_url_refused`；remoteUrlRefusedError 是带这个 code 的 Error，消息只说协议（小写）、
 *         列出能开的三种，**从不复述地址**
 *   RU-9  认不出协议（裸域名、非字符串）→ 消息说 `this address`，照样带 code、不抛
 *   RU-10 networkEnvelope.envelopeErrorOf 把它变成 `{ message, code: 'remote_url_refused' }`（网络客户端收到的 ok:false）
 */
import { describe, expect, it } from 'vitest'
import {
  REMOTE_URL_REFUSED_CODE,
  remoteOpenableUrl,
  remoteUrlRefusedError
} from '../browserRemoteUrls'
import { envelopeErrorOf } from '../networkEnvelope'

describe('RU-1 http(s) 网页', () => {
  it.each([
    'http://a.example/',
    'https://a.example/x?y#z',
    'HTTPS://A.EXAMPLE/',
    'http://127.0.0.1:3000/',
    'http://[::1]:8080/',
    'https://user:pw@a.example/',
    '  https://a.example/  ',
    // 特殊协议少了 `//`：WHATWG URL 照样解析成 https://a.example/
    'https:a.example'
  ])('RU-1 %j → true', (url) => {
    expect(remoteOpenableUrl(url)).toBe(true)
  })
})

describe('RU-2 about:blank', () => {
  it.each(['about:blank', 'ABOUT:BLANK', ' about:blank '])('RU-2 %j → true', (url) => {
    expect(remoteOpenableUrl(url)).toBe(true)
  })

  it.each(['about:blank#x', 'about:blank?x', 'about:srcdoc', 'about:settings', 'about:'])(
    'RU-2 %j → false',
    (url) => {
      expect(remoteOpenableUrl(url)).toBe(false)
    }
  )
})

describe('RU-3 shuvix:// 内部页面', () => {
  it.each([
    'shuvix://settings',
    'shuvix://history',
    'SHUVIX://Settings',
    'shuvix://settings/',
    'shuvix://history?q=x',
    'shuvix://settings#privacy'
  ])('RU-3 %j → true', (url) => {
    expect(remoteOpenableUrl(url)).toBe(true)
  })

  it.each([
    'shuvix://unknown',
    'shuvix://',
    'shuvix:settings',
    'shuvix://settings/sub',
    'shuvix://settings/../x',
    'shuvix://settings\nfile:///x'
  ])('RU-3 %j → false', (url) => {
    expect(remoteOpenableUrl(url)).toBe(false)
  })
})

describe('RU-4 别的协议', () => {
  it.each([
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    'file://localhost/etc/passwd',
    'file:',
    'view-source:https://a.example/',
    'view-source:file:///etc/passwd',
    'data:text/html,<b>x</b>',
    'blob:https://a.example/uuid',
    'filesystem:https://a.example/temporary/x',
    'chrome://settings',
    'chrome-extension://abc/x',
    'devtools://devtools/bundled/inspector.html',
    'javascript:alert(1)',
    'ftp://a.example/',
    'ws://a.example/'
  ])('RU-4 %j → false', (url) => {
    expect(remoteOpenableUrl(url)).toBe(false)
  })
})

describe('RU-5 不是绝对地址', () => {
  it.each([
    '',
    '   ',
    'a.example',
    '//a.example/',
    '/etc/passwd',
    '~/secret.txt',
    'http://',
    'localhost:3000',
    'C:\\Windows\\win.ini'
  ])('RU-5 %j → false', (url) => {
    expect(remoteOpenableUrl(url)).toBe(false)
  })
})

describe('RU-6 藏起来的 file:', () => {
  it.each([
    '\tfile:///etc/passwd',
    ' file:///etc/passwd',
    '\u00a0file:///x',
    '\x00file:///etc/passwd',
    'fi\nle:///etc/passwd'
  ])('RU-6 %j → false', (url) => {
    expect(remoteOpenableUrl(url)).toBe(false)
  })
})

describe('RU-7 不是字符串', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['42', 42],
    ['true', true],
    ['{}', {}],
    ['数组', ['https://a.example/']],
    ['URL 对象', new URL('https://a.example/')],
    ['带 toString 的对象', { toString: () => 'https://a.example/' }]
  ])('RU-7 %s → false、不抛', (_label, value) => {
    expect(() => remoteOpenableUrl(value)).not.toThrow()
    expect(remoteOpenableUrl(value)).toBe(false)
  })
})

describe('RU-8 拒绝的错误', () => {
  it("RU-8 错误码是 'remote_url_refused'", () => {
    expect(REMOTE_URL_REFUSED_CODE).toBe('remote_url_refused')
  })

  it('RU-8 file:（大写）：Error、带 code，消息只说 `file: addresses`、列出能开的三种，不复述地址', () => {
    const error = remoteUrlRefusedError('FILE:///Users/me/secret.txt')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(REMOTE_URL_REFUSED_CODE)
    expect(error.message).toContain('file: addresses')
    for (const allowed of ['http', 'https', 'about:blank', 'shuvix://']) {
      expect(error.message).toContain(allowed)
    }
    expect(error.message).not.toContain('/Users/me/secret.txt')
    expect(error.message).not.toContain('secret')
    expect(error.message).not.toContain('/Users')
  })

  it.each<[string, string]>([
    ['view-source:file:///x', 'view-source: addresses'],
    [' data:text/html,x', 'data: addresses']
  ])('RU-8 %j → 消息说 %j', (url, words) => {
    const error = remoteUrlRefusedError(url)
    expect(error.code).toBe(REMOTE_URL_REFUSED_CODE)
    expect(error.message).toContain(words)
    expect(error.message).not.toContain('text/html')
    expect(error.message).not.toContain('///x')
  })
})

describe('RU-9 认不出协议', () => {
  it.each<[string, unknown]>([
    ['裸域名', 'a.example'],
    ['undefined', undefined],
    ['42', 42],
    ['{}', {}]
  ])('RU-9 %s → `this address`，带 code、不抛', (_label, value) => {
    expect(() => remoteUrlRefusedError(value)).not.toThrow()
    const error = remoteUrlRefusedError(value)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(REMOTE_URL_REFUSED_CODE)
    expect(error.message).toContain('this address')
    expect(error.message).not.toContain(' addresses')
  })
})

describe('RU-10 网络客户端收到的错误', () => {
  it("RU-10 envelopeErrorOf(…, 'handler_error') → { message, code: 'remote_url_refused' }", () => {
    const error = remoteUrlRefusedError('file:///x')
    expect(envelopeErrorOf(error, 'handler_error')).toStrictEqual({
      message: error.message,
      code: 'remote_url_refused'
    })
  })
})
