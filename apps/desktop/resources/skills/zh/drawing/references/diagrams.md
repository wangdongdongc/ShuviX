# 框与箭头

流程、结构、分层、前后对比 —— 一切由框和箭头组成的图。和这里的其他图一样，手画。

**用来讲清楚的图，必须比它讲的东西小。** 有人要一张方案的图，要的是比方案**少**的东西：它的形状、要紧的那一处。把每一步都变成一个框，是把同样的复杂度换一种更难读的记法还回去。方案是你写的，所以三十个框的图你读得顺 —— 对读者来说，它没有入口。

## 动笔之前

1. **说出这张图回答的那一个问题** ——「分几个阶段」「请求走到哪里」「什么依赖什么」「改了什么」。把它写进根上的 `aria-label`：那就是图的标题。
2. **数一数有几个部分。** 超过 5 个框，一张图就不是正确答案 —— 见「拆开」。
3. **按问题选形状**，不是按题材：

| 问题 | 画成 |
|---|---|
| 按什么顺序发生什么 | 单一方向的流程：4 个框以内从左到右，更多就从上到下 |
| 什么在什么里面 | 一个外层区域，里面并排 2–4 个区域；最多两层 |
| 什么叠在什么上面 | 一摞通栏色带，从上到下 |
| 改了什么 | 前后对比：两列相同的框，标出变了的那个 |
| 什么在循环 | 一条直的流程加一根回指箭头 —— 绝不把框摆成一圈 |

不是每个方案都是流程。几个阶段依次推进，往往一行 3–5 个、没有分支的框最清楚；几个选项的对比是表格，不是图。

## 预算

- **一张图最多 5 个框，一行最多 4 个。**
- **框里是短语**：约 5 个词，或 10 个汉字。第二行只在它承载一个事实时才加；绝不写句子。
- **一处强调。** 要紧的那个框 —— 风险、改动、答案 —— 被标出来，其余保持中性。
- **箭头不带标签**，除非从两端看不出它的含义；那时最多 3 个词，放在空处。

## 拆开

部分比预算多时：

1. **先画总览**：3–5 个框，只有主干 —— 不扇出、不织网、不画异常路径。
2. **再为值得展开的部分各画一张小图**，每张之前用一句话说清它放大的是哪一块。
3. **或者画完总览就停**，问要展开哪一块。读者要的是看懂；完整可以分几张图给，绝不塞进一张。

只承诺你画了的：文字说「两张图」，就两张都画。

## 几何 —— 写坐标之前先算

`viewBox` 用 640 宽，左右各留 20 的边距，可用宽度 600。

- **文字宽度**：拉丁字符按 字号 × 0.6，汉字按 字号 × 1.0。框宽 = 最宽的标签 + 32 的内边距，向上取整。
- **一行排得下吗**：n 个宽 w 的框、间距 g，需要 n·w + (n − 1)·g ≤ 600。排不下就缩短标签或换到第二行 —— 框永远不相碰、不重叠。
- **间距**：顺着流程方向至少 40（给箭头留地方），横向至少 16。
- **同类同尺寸**：所有单行的框同一个高度（字号 13 时为 36）。
- **文字居中**：`x` = 框的 x + 宽 / 2，`y` = 框的 y + 高 / 2，并在 `<text>` 本身上写 `text-anchor="middle"` 和 `dominant-baseline="central"`。
- **高度**：`viewBox` 的高 = 最低元素的底边 + 20。任何东西都不出界。

## 箭头

定义一个 marker，反复用：

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M1 1L9 5L1 9" fill="none" stroke="var(--theme-text-tertiary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
```

- **箭头从边到边**：起点在源框的边上，终点离目标框的边 4 个单位。两端都从框的位置算出来；绝不从中心连到中心。
- **箭头不穿过别的框，也不穿过标签。** 直线会穿过时，用直角绕开：`<path d="M x1 y1 V ymid H x2 V y2" fill="none" .../>`。每条连线 `<path>` 都要 `fill="none"`。
- **箭头顺着流程走。** 回指箭头是唯一的例外，一张图最多一根。

## 颜色

- **框**：`fill="var(--theme-bg-secondary)"`、`stroke="var(--theme-border-primary)"`，标签用 `var(--theme-text-primary)`。
- **强调**：同样的框，改成 `stroke="var(--viz-1)"`、`stroke-width="1.5"` —— 它表示一种状态时用状态 token（风险用 `--viz-warn`，失败用 `--viz-critical`）。标签仍用文字 token。
- **区域**（包含关系图的外层框）：`fill="none"`、虚线边框（`stroke-dasharray="4 4"`），区域名写在它里面的左上角。
- **连线**：`var(--theme-text-tertiary)`，线宽 1。

## 一个成形的例子

一个迁移方案，被问到「怎么走、险在哪」：四步，一处强调，没有分支。

```svg
<svg viewBox="0 0 640 114" role="img" aria-label="迁移分四步；双写这一步风险最大">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1L9 5L1 9" fill="none" stroke="var(--theme-text-tertiary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect x="20" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--theme-border-primary)"/>
  <rect x="180" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--viz-1)" stroke-width="1.5"/>
  <rect x="340" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--theme-border-primary)"/>
  <rect x="500" y="30" width="120" height="36" rx="6" fill="var(--theme-bg-secondary)" stroke="var(--theme-border-primary)"/>
  <line x1="140" y1="48" x2="176" y2="48" stroke="var(--theme-text-tertiary)" marker-end="url(#arrow)"/>
  <line x1="300" y1="48" x2="336" y2="48" stroke="var(--theme-text-tertiary)" marker-end="url(#arrow)"/>
  <line x1="460" y1="48" x2="496" y2="48" stroke="var(--theme-text-tertiary)" marker-end="url(#arrow)"/>
  <text x="80" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">拆出新接口</text>
  <text x="240" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">双写 + 回填</text>
  <text x="400" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">切读流量</text>
  <text x="560" y="48" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="13" fill="var(--theme-text-primary)">下线旧表</text>
  <text x="240" y="88" text-anchor="middle" dominant-baseline="central" font-family="var(--theme-font-sans)" font-size="11" fill="var(--theme-text-secondary)">风险在这一步</text>
</svg>
```

背后的算术：最宽的标签「拆出新接口」是 5 × 13 = 65，加 32 的内边距 = 97，取整到 120 与其余框看齐。四个 120 宽的框加三个 40 的间距一共 600 —— 正好是可用宽度。每根箭头从框的右边出发，停在下一个框前 4 个单位。

## 收工前检查

- 最多 5 个框，一行最多 4 个。
- 按上面的算术，每个标签都装得进它的框。
- 没有箭头穿过框或标签；没有标签碰到线。
- 一切都在 `viewBox` 以内。
- 以一个没看过方案的人的眼光读一遍：他能在五秒内说出这张图讲了什么吗？不能就删。
