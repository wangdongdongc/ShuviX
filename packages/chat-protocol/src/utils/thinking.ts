/**
 * 思考内容判定 —— 模型偶尔会吐出**只有空白**的 thinking 块（实测见过整块只有一个
 * `"\n"` 的），它有内容长度但没有任何可读文字，直接渲染就是对话流里一段莫名其妙的
 * 空白可点区域。凡是「要不要把这段思考渲染出来 / 落成一条 step」的判断都走这里，
 * 避免各处各写一遍 trim 而漏掉某一条路径。
 */
export function hasThinkingContent(thinking: string | null | undefined): thinking is string {
  return !!thinking && thinking.trim().length > 0
}
