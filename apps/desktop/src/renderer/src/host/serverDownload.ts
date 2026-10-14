import { networkDownloadUrl } from '../../../shared/networkRoutes'

/**
 * 浏览器里的 web 客户端：把运行 ShuviX 的那台电脑上的一个文件下载到浏览器这边（server mode phase D）——
 * 经网络服务的 `/files/download`（它回 `Content-Disposition: attachment`）。一个临时的 `<a download>` 点一下：
 * 与页面同源，浏览器按下载处理、不离开页面。桌面不用它（桌面直接写到用户在保存框里选的地方）。
 */
export function downloadServerFile(absolutePath: string): void {
  const link = document.createElement('a')
  link.href = networkDownloadUrl(absolutePath)
  link.download = absolutePath.split(/[\\/]/).pop() || 'download'
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
