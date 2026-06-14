import { describe, it, expect } from 'vitest'
import { cleanMarkdownForTts } from '../cleanMarkdown'

describe('cleanMarkdownForTts', () => {
  it('纯文本不变', () => {
    expect(cleanMarkdownForTts('你好世界')).toBe('你好世界')
  })

  it('空文本返回空字符串', () => {
    expect(cleanMarkdownForTts('')).toBe('')
    expect(cleanMarkdownForTts('   ')).toBe('')
  })

  it('去掉标题 # 前缀', () => {
    expect(cleanMarkdownForTts('# 标题一')).toBe('标题一')
    expect(cleanMarkdownForTts('## 二级标题')).toBe('二级标题')
    expect(cleanMarkdownForTts('### 三级')).toBe('三级')
  })

  it('去掉加粗标记', () => {
    expect(cleanMarkdownForTts('这是**加粗**文字')).toBe('这是加粗文字')
    expect(cleanMarkdownForTts('这是__加粗__文字')).toBe('这是加粗文字')
  })

  it('去掉斜体标记', () => {
    expect(cleanMarkdownForTts('这是*斜体*文字')).toBe('这是斜体文字')
  })

  it('去掉加粗斜体 ***', () => {
    expect(cleanMarkdownForTts('***重点***')).toBe('重点')
  })

  it('不误伤 snake_case', () => {
    const text = 'use my_variable_name here'
    expect(cleanMarkdownForTts(text)).toBe(text)
  })

  it('去掉删除线', () => {
    expect(cleanMarkdownForTts('~~已删除~~')).toBe('已删除')
  })

  it('链接转为显示文本', () => {
    expect(cleanMarkdownForTts('[点击这里](https://example.com)')).toBe('点击这里')
  })

  it('图片转为 alt 文本', () => {
    expect(cleanMarkdownForTts('![示意图](https://img.png)')).toBe('示意图')
  })

  it('去掉行内代码反引号', () => {
    expect(cleanMarkdownForTts('运行 `npm install` 命令')).toBe('运行 npm install 命令')
  })

  it('整块移除 fenced code block', () => {
    const md = '前文\n```js\nconsole.log("hi")\n```\n后文'
    expect(cleanMarkdownForTts(md)).toBe('前文\n\n后文')
  })

  it('移除 thinking 标签及其内容', () => {
    const md = '<thinking>内部推理</thinking>最终答案'
    expect(cleanMarkdownForTts(md)).toBe('最终答案')
  })

  it('移除 HTML 标签保留文本', () => {
    expect(cleanMarkdownForTts('<b>加粗</b>')).toBe('加粗')
    expect(cleanMarkdownForTts('<br/>')).toBe('')
  })

  it('移除 HTML 注释', () => {
    expect(cleanMarkdownForTts('文本<!-- 注释 -->继续')).toBe('文本继续')
  })

  it('去掉引用前缀', () => {
    expect(cleanMarkdownForTts('> 引用内容')).toBe('引用内容')
  })

  it('去掉无序列表标记', () => {
    const md = '- 项目一\n- 项目二'
    expect(cleanMarkdownForTts(md)).toBe('项目一\n项目二')
  })

  it('去掉有序列表标记', () => {
    const md = '1. 第一步\n2. 第二步'
    expect(cleanMarkdownForTts(md)).toBe('第一步\n第二步')
  })

  it('清理表格语法', () => {
    const md = '| 名称 | 说明 |\n|---|---|\n| A | B |'
    const result = cleanMarkdownForTts(md)
    expect(result).not.toContain('|')
    expect(result).not.toContain('---')
    expect(result).toContain('A')
    expect(result).toContain('B')
  })

  it('移除水平线', () => {
    expect(cleanMarkdownForTts('上文\n---\n下文')).toBe('上文\n\n下文')
    expect(cleanMarkdownForTts('上文\n***\n下文')).toBe('上文\n\n下文')
  })

  it('移除 Emoji', () => {
    expect(cleanMarkdownForTts('你好😀世界🌍')).toBe('你好世界')
    expect(cleanMarkdownForTts('🎉 恭喜完成！🚀')).toBe('恭喜完成！')
    expect(cleanMarkdownForTts('纯文本无emoji')).toBe('纯文本无emoji')
  })

  it('移除引用式链接定义', () => {
    expect(cleanMarkdownForTts('[1]: https://example.com')).toBe('')
  })

  it('合并多余空行', () => {
    expect(cleanMarkdownForTts('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('处理真实 LLM 混合输出', () => {
    const md = `<thinking>让我想想...</thinking>

## 解决方案

这是一个**重要**的问题。你可以参考[文档](https://docs.example.com)。

\`\`\`python
print("hello")
\`\`\`

具体步骤：
1. 安装依赖
2. 运行 \`npm start\`

> 注意：请确保 Node.js 版本 >= 18

---

| 工具 | 用途 |
|------|------|
| ESLint | 代码检查 |`

    const result = cleanMarkdownForTts(md)

    // 不应包含 markdown 语法
    expect(result).not.toContain('##')
    expect(result).not.toContain('**')
    expect(result).not.toContain('```')
    expect(result).not.toContain('[文档]')
    expect(result).not.toContain('<thinking>')
    expect(result).not.toContain('|')
    expect(result).not.toContain('---')

    // 应保留有意义的文本
    expect(result).toContain('解决方案')
    expect(result).toContain('重要')
    expect(result).toContain('文档')
    expect(result).toContain('安装依赖')
    expect(result).toContain('npm start')
    expect(result).toContain('ESLint')
  })
})
