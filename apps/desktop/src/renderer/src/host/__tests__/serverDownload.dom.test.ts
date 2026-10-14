// @vitest-environment jsdom
/**
 * `host/serverDownload.ts`（server mode phase D）—— web 客户端把服务端上的一个文件下载到浏览器这边：一个临时的
 * `<a download>` 指向网络服务的 `/files/download`，点一下就摘掉。`HTMLAnchorElement.prototype.click` 换成间谍
 * （jsdom 不做导航），点的那一刻记下锚点的样子。
 *
 *   SD-1 恰点一个锚点：href 是 `/files/download?path=<编码的绝对路径>`，download 是文件名，rel=noopener；点的时候在页面上，
 *        之后摘掉
 *   SD-2 Windows 路径取最后一段（`C:\a\b.zip` → b.zip）；以分隔符结尾的路径 → "download"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { networkDownloadUrl } from '../../../../shared/networkRoutes'
import { downloadServerFile } from '../serverDownload'

interface Clicked {
  href: string | null
  download: string
  rel: string
  connected: boolean
  anchor: HTMLAnchorElement
}

let clicked: Clicked[]

beforeEach(() => {
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push({
      href: this.getAttribute('href'),
      download: this.download,
      rel: this.rel,
      connected: this.isConnected,
      anchor: this
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('SD-1 一个临时锚点', () => {
  it('SD-1 href / download / rel；点的时候在页面上，之后摘掉', () => {
    const path = '/u/x/widget-exports/export-1/demo widget.zip'
    downloadServerFile(path)

    expect(clicked).toHaveLength(1)
    const [click] = clicked
    expect(click.href).toBe(
      '/files/download?path=%2Fu%2Fx%2Fwidget-exports%2Fexport-1%2Fdemo%20widget.zip'
    )
    expect(click.href).toBe(networkDownloadUrl(path))
    expect(click.download).toBe('demo widget.zip')
    expect(click.rel).toBe('noopener')
    expect(click.connected).toBe(true)
    expect(click.anchor.isConnected).toBe(false)
    expect(document.querySelectorAll('a')).toHaveLength(0)
  })
})

describe('SD-2 文件名', () => {
  it('SD-2 Windows 路径取最后一段；以分隔符结尾 → download', () => {
    downloadServerFile('C:\\a\\b.zip')
    downloadServerFile('/a/')
    expect(clicked.map((c) => c.download)).toStrictEqual(['b.zip', 'download'])
    expect(clicked[0].href).toBe(networkDownloadUrl('C:\\a\\b.zip'))
    expect(document.querySelectorAll('a')).toHaveLength(0)
  })
})
