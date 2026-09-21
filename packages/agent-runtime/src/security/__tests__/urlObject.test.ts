/**
 * urlObjectOf —— 地址 → `{type:'url'}` 客体的输入。两端的导航门都经它构造客体，
 * 所以这里钉的是策略作者能依赖的写法：
 *   UO-1…3  主机名：小写、去掉结尾的点（按 host 写的规则不能被一个点绕开）、IPv6 保留方括号；
 *   UO-4…6  url：去掉账号口令（客体会原样上询问卡片与决策日志）、写回规整后的主机，
 *           路径 / 查询 / 片段一字不改；不透明来源的协议也照样规整主机；
 *   UO-7…9  scheme 不带冒号；origin 对不透明来源是 'null'、没有主机时 host 是空串，
 *           其余是 `scheme://host[:port]`（默认端口省略）；
 *   UO-10   解析不了就抛（门之前应已校验，客体不该带着猜出来的属性去求值）。
 *   UO-11   blob: 自己没有主机，属于创建它的那个源 —— host / origin 按那个源给（规整同上）。
 *
 * 只规整给策略看的这一份 —— 真正导航去哪仍是调用方手里的原地址（见两端宿主的接线测试）。
 */
import { describe, expect, it } from 'vitest'
import { urlObjectOf } from '../urlObject'
import type { UrlObjectInput } from '../types'

describe('urlObjectOf', () => {
  it.each<[string, UrlObjectInput]>([
    [
      'https://Evil.Example./x',
      {
        url: 'https://evil.example/x',
        scheme: 'https',
        host: 'evil.example',
        origin: 'https://evil.example'
      }
    ],
    [
      'https://evil.example.:8443/x',
      {
        url: 'https://evil.example:8443/x',
        scheme: 'https',
        host: 'evil.example',
        origin: 'https://evil.example:8443'
      }
    ],
    [
      'https://a.b.example.../',
      {
        url: 'https://a.b.example/',
        scheme: 'https',
        host: 'a.b.example',
        origin: 'https://a.b.example'
      }
    ],
    [
      'HTTPS://A.EXAMPLE/',
      { url: 'https://a.example/', scheme: 'https', host: 'a.example', origin: 'https://a.example' }
    ]
  ])('UO-1 %s → 主机名小写、结尾的点（一个或几个）都去掉，url 里写回的也是它', (raw, expected) => {
    expect(urlObjectOf(raw)).toEqual(expected)
  })

  it('UO-2 同一台机器，写法不同 → 同一个 host / origin（按 host 写的规则只需要写一遍）', () => {
    const variants = [
      'https://evil.example/x',
      'https://Evil.Example/x',
      'https://evil.example./x',
      'https://EVIL.EXAMPLE../x',
      'https://someone:secret@evil.example./x'
    ].map(urlObjectOf)
    for (const v of variants) {
      expect(v.host).toBe('evil.example')
      expect(v.origin).toBe('https://evil.example')
      expect(v.url).toBe('https://evil.example/x')
    }
  })

  it.each<[string, UrlObjectInput]>([
    [
      'http://[::1]:3000/',
      { url: 'http://[::1]:3000/', scheme: 'http', host: '[::1]', origin: 'http://[::1]:3000' }
    ],
    [
      'http://127.0.0.1:8080/',
      {
        url: 'http://127.0.0.1:8080/',
        scheme: 'http',
        host: '127.0.0.1',
        origin: 'http://127.0.0.1:8080'
      }
    ],
    [
      'http://localhost:8080/',
      {
        url: 'http://localhost:8080/',
        scheme: 'http',
        host: 'localhost',
        origin: 'http://localhost:8080'
      }
    ]
  ])('UO-3 %s：IP 字面量原样，IPv6 保留方括号', (raw, expected) => {
    expect(urlObjectOf(raw)).toEqual(expected)
  })

  it.each<[string, UrlObjectInput]>([
    [
      'https://User:pw@Evil.Example:8443/a?b#c',
      {
        url: 'https://evil.example:8443/a?b#c',
        scheme: 'https',
        host: 'evil.example',
        origin: 'https://evil.example:8443'
      }
    ],
    [
      'https://user@host.example/',
      {
        url: 'https://host.example/',
        scheme: 'https',
        host: 'host.example',
        origin: 'https://host.example'
      }
    ],
    [
      'https://:pw@a.example/',
      { url: 'https://a.example/', scheme: 'https', host: 'a.example', origin: 'https://a.example' }
    ]
  ])('UO-4 %s：账号口令不进客体（只有用户名、只有口令也一样）', (raw, expected) => {
    const object = urlObjectOf(raw)
    expect(object).toEqual(expected)
    expect(JSON.stringify(object)).not.toMatch(/pw|User|user@/)
  })

  it('UO-5 路径、查询与片段一字不改（大小写也不动），只规整主机', () => {
    expect(urlObjectOf('https://A.example/Path/To?Q=1&r=Two#Frag')).toEqual({
      url: 'https://a.example/Path/To?Q=1&r=Two#Frag',
      scheme: 'https',
      host: 'a.example',
      origin: 'https://a.example'
    })
  })

  it.each<[string, UrlObjectInput]>([
    ['foo://u:p@Host./p', { url: 'foo://host/p', scheme: 'foo', host: 'host', origin: 'null' }],
    [
      'chrome://Settings./x',
      { url: 'chrome://settings/x', scheme: 'chrome', host: 'settings', origin: 'null' }
    ],
    [
      'chrome://settings',
      { url: 'chrome://settings', scheme: 'chrome', host: 'settings', origin: 'null' }
    ]
  ])('UO-6 %s：不透明来源的协议带主机时同样规整（origin 仍是 null）', (raw, expected) => {
    expect(urlObjectOf(raw)).toEqual(expected)
  })

  it.each<[string, UrlObjectInput]>([
    ['data:text/html,x', { url: 'data:text/html,x', scheme: 'data', host: '', origin: 'null' }],
    ['about:blank', { url: 'about:blank', scheme: 'about', host: '', origin: 'null' }],
    [
      'javascript:alert(1)',
      { url: 'javascript:alert(1)', scheme: 'javascript', host: '', origin: 'null' }
    ],
    [
      'mailto:Someone@Example.com',
      { url: 'mailto:Someone@Example.com', scheme: 'mailto', host: '', origin: 'null' }
    ],
    ['file:///tmp/a.html', { url: 'file:///tmp/a.html', scheme: 'file', host: '', origin: 'null' }]
  ])('UO-7 %s：没有主机 → host 是空串、origin 是 null，scheme 不带冒号', (raw, expected) => {
    expect(urlObjectOf(raw)).toEqual(expected)
  })

  it.each<[string, UrlObjectInput]>([
    [
      'https://a.example:443/',
      { url: 'https://a.example/', scheme: 'https', host: 'a.example', origin: 'https://a.example' }
    ],
    [
      'http://a.example:80/x',
      { url: 'http://a.example/x', scheme: 'http', host: 'a.example', origin: 'http://a.example' }
    ],
    [
      'ws://Echo.Example.:81/s',
      {
        url: 'ws://echo.example:81/s',
        scheme: 'ws',
        host: 'echo.example',
        origin: 'ws://echo.example:81'
      }
    ]
  ])('UO-8 %s：默认端口省略，非默认端口进 origin', (raw, expected) => {
    expect(urlObjectOf(raw)).toEqual(expected)
  })

  it('UO-9 只有这四个键 —— 没有 type（那是 enforceUrl 加的），也没有账号口令的位置', () => {
    expect(Object.keys(urlObjectOf('https://u:p@a.example/')).sort()).toEqual([
      'host',
      'origin',
      'scheme',
      'url'
    ])
  })

  it.each(['not a url', '', 'example.com', '//a.example/x', 'localhost'])(
    'UO-10 %j 解析不了 → 抛出（门之前应已校验）',
    (raw) => {
      expect(() => urlObjectOf(raw)).toThrow(TypeError)
    }
  )

  it.each<[string, UrlObjectInput]>([
    [
      'blob:https://a.example/0b1c',
      {
        url: 'blob:https://a.example/0b1c',
        scheme: 'blob',
        host: 'a.example',
        origin: 'https://a.example'
      }
    ],
    [
      'blob:https://A.Example.:8443/0b1c',
      {
        url: 'blob:https://A.Example.:8443/0b1c',
        scheme: 'blob',
        host: 'a.example',
        origin: 'https://a.example:8443'
      }
    ],
    ['blob:null/0b1c', { url: 'blob:null/0b1c', scheme: 'blob', host: '', origin: 'null' }]
  ])('UO-11 %s：blob: 按创建它的那个源给 host / origin（url 原样）', (raw, expected) => {
    expect(urlObjectOf(raw)).toEqual(expected)
  })
})
