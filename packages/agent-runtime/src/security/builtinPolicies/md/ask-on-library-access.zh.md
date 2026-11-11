---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-library-access
shuvix-builtin: true
name: ask-on-library-access
shuvix-displayName: 读取文件库里别的文件前询问
description: 智能体可以自由读取属于本会话的库文件；读文件库里的其他文件，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [library]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !(has(object.linked) && object.linked)
    prompt: 这会让智能体读到文件库里一个这段对话没有用过的文件。
---

**它做什么**：笔记和对话用 `shuvix://file/…` 链接指向文件库里的文件，智能体用 `read` 打开它们。属于本会话的库文件，
智能体可以自由读取：

- 你在这段对话里发送过的图片；
- 你粘贴、拖入或插入到本会话笔记里的文件。

笔记里只是写了一条库链接不算：笔记智能体也能写。

读文件库里的其他文件，**先问你**。

**为什么问**：文件库里存着每篇笔记、每段对话的文件。指向它们的链接可能出现在任何地方：智能体读到的一篇笔记、一个网页、
一次工具的结果。顺着链接读，不该悄悄交出属于别处的文件。

**它不做什么**：

- 自动审核可以回答这类询问，和读工作目录以外的文件一样。
- 在笔记和对话里给你显示库里的图片从不询问，只有智能体读它们时才问。

**怎么调整**：创建一份覆盖副本再改。删掉这条规则，智能体读任何库文件都不再询问。
