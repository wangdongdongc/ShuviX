# 跟踪项的文件格式

```markdown
---
shuvix: track v1
status: active
---

# 等李回复数据库迁移方案

（有结论了就写在这里，一两句。）

## 进展

- 10-24：在 [迁移评审](shuvix://session/<会话 id>) 里用户说「先等李那边回复再定」。
```

- 开头的 frontmatter 是 `shuvix: track v1` 和 `status` 两行；新建时写 `status: active`。`status` 只有三个值：`active` / `waiting` / `archived`，什么时候改哪个见 SKILL.md 的「状态」。改它时只改这一行，frontmatter 里别的行不动。
- 正文第一行是 `# 标题`，收件箱里显示的就是它；收件箱那一行下面显示的是最后一条进展。
- 文件名用简短的小写英文或拼音加连字符，例如 `waiting-li-migration.md`。
- 进展在 `## 进展` 下按日期往下追加，每条带来源会话的链接 `[会话标题](shuvix://session/<会话 id>)`；直接新建的项，第一条进展引用用户那句原话。
- 有了结论，写在标题下面第一段；进展照留。归档的项在收件箱里显示的就是这一段。
