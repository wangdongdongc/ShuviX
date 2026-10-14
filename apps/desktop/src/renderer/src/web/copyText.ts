/**
 * 复制一段文字。局域网地址（`http://192.168.x.x:7766`）不是安全上下文，`navigator.clipboard` 在那里根本不存在 ——
 * 退回到老办法：一个看不见的 textarea + `document.execCommand('copy')`（它在不安全的上下文里照样能用，只要是在
 * 用户的点击里调的）。都不行 → false（调用方让用户自己选中复制）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 退回到 execCommand */
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}
