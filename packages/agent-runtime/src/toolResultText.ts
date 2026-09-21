/**
 * 工具结果 → 界面上显示的那段文字 —— 实时广播与重开会话**同一个函数**。
 *
 * 以前有三份各自的写法：桌面根会话的实时路径（图片换占位、按行拼）、宿主不注入时的缺省转换
 * （图片 JSON.stringify —— 整段 base64 铺进工具卡片）、重开会话的投影（文本直接首尾相连、图片丢掉）。
 * 一次结果若是「文字 + 图 + 文字」，同一张卡片在跑着的时候和重开之后显示两样东西。
 * MCP 结果如今可以带图、也可以是多段文字，这个分歧就从边角变成了常态，所以收成一处。
 *
 * 占位是写给**用户**看的：模型读的是 entry 树里的原图，永远看不到这句。措辞别说成「这里看不到图」
 * —— 工具卡片会另外把 details.image 那张图显示出来（ToolImageThumb），这句只解释
 * 「base64 没在这儿重复一遍」。
 */
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

/** 图片块在界面文字里的占位 */
export function imagePlaceholder(mimeType: string): string {
  return `[image (${mimeType}) — delivered to the model in full; the base64 is not repeated in the UI.]`
}

/** 内容块数组 → 界面文字：文本原样、图片换占位、其余 JSON；块与块之间换行 */
export function toolResultText(
  content: string | ReadonlyArray<TextContent | ImageContent> | undefined
): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map((c) =>
      c.type === 'text'
        ? (c.text ?? '')
        : c.type === 'image'
          ? imagePlaceholder(c.mimeType)
          : JSON.stringify(c)
    )
    .join('\n')
}
