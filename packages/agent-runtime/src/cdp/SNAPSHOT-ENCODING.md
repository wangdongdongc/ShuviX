# browser snapshot 编码优化

> 状态：**格式化层已实现**（含缺陷 #1/#3/#4/#5 的修复）；差异回传（diff）为后续阶段，尚未开工。
> 本文记录的所有数字都来自实测，不是估算。来源在文末。

## 为什么

`snapshot` 是浏览器会话里最贵的单个操作，比截图还贵，而且铁律要求
`click`/`fill`/`type` 之前必须先做，所以它的频次由交互次数决定，压不下来。

实测一个真实的浏览器密集会话（`kimi-k3`，619 条消息，210 次 browser 调用）：

| action       | 次数 | 均值           | 合计       |
| ------------ | ---- | -------------- | ---------- |
| **snapshot** | 16   | **1,977 tok**  | **31,632** |
| read_page    | 28   | 627            | 17,565     |
| network      | 11   | 383            | 4,215      |
| console      | 2    | 1,670          | 3,340      |
| evaluate     | 44   | **93**         | 4,131      |
| screenshot   | 10   | 48（只回路径） | 486        |

该会话的 token 构成里 `toolResult:text` 占 **78.5%**，thinking 只占 4.5%。
（对照：另一批用 thinking 冗长模型的会话，thinking 占比完全不同 —— 优化方向
取决于模型和任务，没有普适答案。）

## 当前编码

实现在 `packages/agent-runtime/src/cdp/controller.ts` 的 `buildSnapshot()`，四条规则：

1. `node.ignored` → 跳过自身，继续递归子节点
2. role ∈ `IGNORED_ROLES = {none, generic, InlineTextBox, LineBreak}` **且无名**
   → 跳过自身，递归子节点
3. 每个输出的节点都分配 `uid=eN`（`uidCounter` 递增，36 进制）
4. 行 = `'  '.repeat(depth) + '- uid=eN [role] ["name"] [属性]'`

### 漏点全在第 2 条的「且无名」

浏览器的 AX 树把一段可见文字拆成 `StaticText "X"` → `InlineTextBox "X"` 两层，
**两层都带名字**，于是第 2 条放行，两行都印出来。一个链接因此变三行：

```
- uid=ee link "立即登录"          ← 唯一有用的一行
  - uid=ef StaticText "立即登录"   ← AX 树的实现细节
    - uid=eg "立即登录"           ← InlineTextBox，渲染层细节
```

这不是偶发，是**每一段可见文字的固定开销**。实测 8 次大快照里：

- **23%** 的文本是与上一行同名的纯重复行
- **2,737 / 3,363** 个 uid 分配给了非交互元素（81%）

## 已实现：格式化层

四条规则，都在 `format()` 递归的输出层，**不改任何契约**：

|        | 改法                                                                                             | 修的是什么                      |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| **R1** | 与上一行同名、且 role 被 `IGNORED_ROLES` 抑制的行，直接丢                                        | InlineTextBox 那一层            |
| **R3** | `StaticText` 的 role 名不印，只留引号里的文字                                                    | `StaticText "X"` 里 role 是废话 |
| **R4** | 子孙文字（去相邻重复）拼起来**正好等于自身的 name**，且子孙中无可交互元素、无属性 → 整个子树吞掉 | `link "X"` 下面挂的那层 `"X"`   |
| **R5** | 缩进 2 空格 → 1 空格                                                                             | 深层节点每行白付 5+ tok         |

### 关键发现：`InlineTextBox` 是折行碎片，不是精确重复

原先 `IGNORED_ROLES = {none, generic, InlineTextBox, LineBreak}` 只在**无名时**跳过，
而这四者里 `InlineTextBox` / `LineBreak` 恰恰**都有名字**，于是全部漏了出来。

更要命的是：`InlineTextBox` 是浏览器**折行**产生的文本碎片，一段
`StaticText "很长的一句话"` 会挂上若干 InlineTextBox，各自是这句话的**一截**——

```
- uid=e4z "Accessibility can be viewed as the "ability to access" and benefit from some system…"
 - uid=tt "Accessibility can be viewed as the "ability to access" and benefit"   ← 碎片，不是重复
 - uid=tu "from some system or entity. The concept focuses on enabling"
```

所以「与父同名才丢」的 R1 **抓不到它们**，R4 的拼接比较也会因为碎片间少了空格而失败。
解法是把角色集合按语义拆开：

- `LAYOUT_ONLY_ROLES = {InlineTextBox, LineBreak}` —— 纯排版构造，**无条件不打印**。
  它们不是 DOM 节点（没有 `backendDOMNodeId`，uid 根本解析不了），文字也全部来自父节点。
- `IGNORED_ROLES = {none, generic}` —— 容器角色，有名字时可能承载语义，仅无名时跳过。

这一条拆分把 wikipedia 从 45% 降幅推到 60%，并把「打印了却解析不了的 uid」
从 863 个降到 115 个。

### R4 是大头，且它不是启发式

父节点的 accessible name **本来就是浏览器按 W3C accname 规则从子孙文字算出来的**，
所以「子孙文字 == 自身 name」时子树确实没有新信息。这是规范的推论，不是猜测。

安全边界：子孙里只要有**一个可交互元素**或**带属性**（`[checked]` / `value=` /
`[disabled]` 等），就不吞。

⚠️ **两个实现坑**：

1. **拼接空格**：Chromium 算 accname 时行内元素之间**不插空格**、块级之间插空格，而 AX
   树里没有 display 信息，拼接策略无论选哪个都会错一半（`link "图标带子元素的链接"` 挂两个
   StaticText，带空格拼出来比不上 name）。所以比较**忽略全部空白** —— 这不丢信息：父行印的
   name 才是权威渲染。
2. **相邻去重**：早期 R4 会因树里文字重复而拼不出等于 name 的串，需要先去相邻重复。
   **这条在 `LAYOUT_ONLY_ROLES` 拆分之后已不再起作用** —— 重复的来源（InlineTextBox 层）现在
   压根不进拼接。实测把两处去重守卫全部删掉，13 份真实夹具输出**逐字节不变**。守卫仍保留
   （同名相邻兄弟在合成树上会触发，单测里有活钉），但**别再把它当收益来源**：早期文档说它
   值 23 个百分点，那是拆分之前的结论，现在不成立。

### 实测收益（13 份夹具，新旧编码器同源对比）

对比方法：只比 **body**（剔掉表头行 —— 表头里的 URL 长度会污染统计），两边统一传固定短 URL。

| 夹具           | 行数        | body 字符       | 比值      |
| -------------- | ----------- | --------------- | --------- |
| `wikipedia`    | 5691 → 2363 | 316928 → 116181 | **0.367** |
| `github`       | 2848 → 1036 | 122158 → 42193  | **0.345** |
| `hn`           | 1454 → 683  | 61148 → 22271   | **0.364** |
| `mdn`          | 707 → 348   | 39898 → 17470   | **0.438** |
| `bing`         | 314 → 160   | 16213 → 7414    | **0.457** |
| `app-ui`       | 170 → 76    | 5850 → 2044     | **0.349** |
| `table`        | 42 → 18     | 1214 → 421      | **0.347** |
| `aria-widgets` | 39 → 19     | 1024 → 468      | **0.457** |
| `form-states`  | 35 → 24     | 949 → 571       | **0.602** |
| `example`      | 11 → 6      | 543 → 264       | **0.486** |
| `text-nesting` | 20 → 7      | 518 → 167       | **0.322** |
| `deep-nesting` | 7 → 4       | 201 → 103       | **0.512** |
| `empty`        | 1 → 1       | 28 → 28         | **1.000** |

**合计 566,672 → 209,595 字符，省 63%。** wikipedia 一次快照从 79k tok 降到 29k。

`empty` 比值 1.000 是对的 —— 无可压缩物时不该动它，这本身也是一条回归断言。

早期还评估过 R2（只给可交互元素编 uid），多省约 7 个百分点但有真实行为代价，未采用。

### 为什么不做 R2（只给可交互元素编 uid）

它只多省 7 个百分点，却有真实行为代价：`help(topic:"devtools")` 里的
「Why is a style not applied」配方要拿**任意元素**的 uid 去做
`CSS.getMatchedStylesForNode`，`{"$uid":"e7"}` 宏也依赖 uid 覆盖全部节点。
非交互元素不印 uid 就用不了。**63% 换零行为变更，划算。**

### 前后对照（真实登录页片段，169 → 71 tok）

```
现状                                     格式化后
- uid=e0 RootWebArea "WPS文档中心…"       - uid=e0 RootWebArea "WPS文档中心…" [focused]
  - uid=e1 StaticText "金山软件test"       - uid=e1 "金山软件test"
    - uid=e2 "金山软件test"                - uid=e3 button "简体中文" [collapsed]
  - uid=e3 button "简体中文" [collapsed]    - uid=e8 paragraph
    - uid=e4 image                          - uid=e9 "账号登录"
    - uid=e5 StaticText "简体中文"         - uid=eb textbox "账号"
      - uid=e6 "简体中文"                  - uid=ec textbox "密码"
    - uid=e7 image                         - uid=ed button
  - uid=e8 paragraph                       - uid=ee link "立即登录"
    - uid=e9 StaticText "账号登录"         - uid=eh link "忘记密码"
      - uid=ea "账号登录"
  …（还有 10 行）
```

## 差异回传（已实现）

实现在 `snapshotDiff.ts`，由 `buildSnapshot(url, {full})` 调用，判定在 `browser/tool.ts`。

### 实测收益（四组真实的「动作前后」AX 树对）

| 场景                     | 全量        | 差异    | 省      |
| ------------------------ | ----------- | ------- | ------- |
| hn 只滚动（AX 树零变化） | 22,577 字符 | **193** | **99%** |
| 整树重渲染               | 661         | 277     | 58%     |
| 表单填值                 | 604         | 280     | 54%     |
| 追加一行                 | 722         | 333     | 54%     |

小页面上表头本身就是主要成本，所以比例看着不如大页面 —— 这也是表头措辞要克制的原因。

### 比对方式：按 uid，不做 LCS

uid 现在是稳定的内容身份，直接按 uid 配对即可，O(n)；LCS 在 wikipedia 这种 2000+ 行
的页面上是 O(n²)。代价是**顺序变化看不出来**（同一行换位置但文本不变），所以额外做
一次「幸存 uid 的相对顺序是否保持」检查，不保持就退回全量。

### 安全边界：三道防线

diff 有个结构性弱点 —— 它依赖模型上下文里还留着上一份快照，而自动压缩可能把它删掉，
**工具无从知道这件事**。曾考虑「交给 agent 自己决定」，但本仓库的实测数据不支持：
5 个真实会话里 `help` 调用 0 次、`evaluate` 对 `screenshot` 是 1:8，**agent 系统性地
不用需要额外推理才会想起的可选参数**。而且失败方向不对称：默认全量+选择性开差异，
不用只是没省到；默认差异+选择性要全量，不用就是**静默误读**。所以：

1. **工具侧的确定性判断**：只在「距上次快照没隔几次操作」时请求差异
   （`MAX_OPS_FOR_DIFF`，按 tab 分开计数）。它只数得到本工具自己的调用，是个近似。
2. **输出自证**：表头写明相对于谁、多少行未变、丢了怎么补 —— 模型看得出自己缺不缺
   东西，从而主动重取，把静默误读变成优雅降级。这是丢了上一份时的**唯一防线**。
3. **`snapshot(tabId, full:true)`**：写进常驻的 action 一行描述里（实测有效的位置），
   而不是藏在 `help` 里（实测 0 次调用）。

另外三种「不值得回差异」的情况直接退回全量：没有上一份、变化占比 > 50%、顺序变了。

### 未做：压缩纪元

更彻底的解法是把「压缩纪元」透到工具侧，纪元一变就作废缓存，那样连模型自省都不需要。
`ToolContext` 现在只有 `sessionId` / `requestUserInput` / `emitChatEvent`，没有这个
信号，而压缩发生在 `harnessSession.maybeAutoCompact()` —— 要打通一条跨层管线。
已明确押后。

## 测试策略

单测夹具是**真实页面的原始 AX 树**（`Accessibility.getFullAXTree` 的 nodes 数组，
不是渲染后的文本），这样喂给 `buildSnapshot` 的是它的真实输入。

夹具已落在 `__tests__/fixtures/`（13 份，1.7 MB）。抓取时已**瘦身**到
`buildSnapshot` 真正读取的字段（nodeId / childIds / ignored / backendDOMNodeId /
role.value / name.value / 七个白名单 property），原始 5.5 MB → 1.7 MB，顺便让夹具
可人工审阅。

夹具分两类：

- **受控夹具**（每个只钉一条规则）：`text-nesting`（文字嵌套三连）、`form-states`
  （输入/勾选/禁用/必填/select）、`table`、`aria-widgets`（tablist/listbox/heading/
  有无 alt 的图）、`deep-nesting`（10 层 div）、`empty`
- **真实站点**（补规模与脏乱）：`wikipedia` / `github` / `hn` / `mdn` / `bing` /
  `example`，外加 `app-ui`（模仿 ShuviX 设置页的密集 UI）

### 当前编码器在这些夹具上的基线

跑真实 `buildSnapshot()` 得到（transport 打桩返回夹具 nodes）：

| 页面           | AX 节点 | 输出行 | 当前 tokens |
| -------------- | ------- | ------ | ----------- |
| `wikipedia`    | 7259    | 5691   | **79252**   |
| `github`       | 3469    | 2676   | **30559**   |
| `hn`           | 1604    | 1448   | **15303**   |
| `mdn`          | 867     | 705    | **9998**    |
| `bing`         | 509     | 314    | **4073**    |
| `app-ui`       | 188     | 170    | **1503**    |
| `table`        | 45      | 42     | **345**     |
| `aria-widgets` | 43      | 39     | **299**     |
| `form-states`  | 46      | 35     | **280**     |
| `text-nesting` | 22      | 20     | **173**     |
| `example`      | 14      | 11     | **149**     |
| `deep-nesting` | 19      | 7      | **93**      |
| `empty`        | 4       | 1      | **48**      |

**Wikipedia 一次快照 79,252 tok** —— 单次就吃掉 200k 上下文的 40%。这类页面才是
真正的风险；之前实测会话里 1,977 的均值只是因为那些页面朴素。这张表同时是回归
基线：改完之后每行都该显著下降，且降幅不该随后续改动悄悄回弹。

### 抓取时踩过的坑（避免重蹈）

- **`debugger.attach()` 必须在首次 `loadURL` 之后**：对着 about:blank attach 会
  静默卡死，无任何报错，只是永不返回。这个坑吃掉了好几轮排查
- macOS 没有 `timeout` 命令（是 coreutils 的 `gtimeout`）
- 反复创建/销毁 BrowserWindow 会和 debugger 生命周期打架 → 单窗口复用
- `loadURL` 对慢站/被墙的站**永不 resolve** → 必须 `Promise.race` 设上限
- zsh 未匹配的 glob 会中断整条命令（`rm -rf x*` 在无匹配时报错退出）

### 必须覆盖的用例方向

1. R1/R3/R4/R5 各自的行为，以及**关掉某条规则时的回退**
2. R4 的安全边界：子孙含可交互元素 / 含属性 → 不吞
3. R4 的去重前提：不先去相邻重复就会失效（回归钉子）
4. uid 覆盖率不回退：**所有元素仍有 uid**（R2 未采用，`$uid` 宏依赖它）
5. `nodeMap` / `uidMap` / `backendIdToUid` 三个映射与输出行的一致性
6. 空页面、纯文本页、无 name 的装饰性元素
7. 真实夹具上的**体量断言**（相对基线的下降幅度），防止规则被后续改动悄悄削弱

## 参考

- [Snapshots | Playwright MCP](https://playwright.dev/mcp/snapshots) —— refs 只在
  本次快照内有效，导航后必须重拍；每次快照 5,000–15,000 tok
- [Optimize browser_snapshot tool · microsoft/playwright-mcp#915](https://github.com/microsoft/playwright-mcp/issues/915)
- [@tontoko/fast-playwright-mcp](https://www.npmjs.com/package/@tontoko/fast-playwright-mcp)
  —— 把 incremental snapshot 做成默认
- [How Accessibility Tree Formatting Affects Token Cost in Browser MCPs](https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a)
  —— 纯格式化实测省 51–79%（GitHub 78%、HN 79%、Wikipedia 51%）
- [macOS Accessibility Tree For Agents: The Diff After The Click](https://macos-use.dev/t/macos-accessibility-tree-agents)
  —— 前后快照做减法 + 噪声过滤（滚动条/空容器/纯坐标变化）+ 结构化身份
- [Reduce token usage by skipping ignored accessibility nodes · ChromeDevTools/chrome-devtools-mcp#635](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/635)

## 已复现的缺陷（改动前就存在，非本次引入）

以下全部**实测复现**（跑真实 `buildSnapshot` over 夹具），不是推测。

| #   | 缺陷                             | github           | wikipedia | hn           |
| --- | -------------------------------- | ---------------- | --------- | ------------ |
| 1   | `elementCount` ≠ 实际行数        | 2676 vs **2848** | 相等      | 1448 vs 1454 |
| 2   | 打印了但**解析不了**的 uid 占比  | 37%              | **44%**   | 33%          |
| 3   | 同一棵树连拍两次，uid 变动的行数 | 980              | **2499**  | 478          |
| 4   | `nodeMap` 每拍增长（内存泄漏）   | +980             | **+2499** | +478         |

**#1 —— name 含换行导致一个节点渲染成多行。** github 有 170 个 name 为 `"\n  "`
一类纯空白的 `StaticText`，`LineBreak` 的 name 就是 `"\n"`。后果是表头报的
`elementCount` 与实际行数对不上，工具卡片上的数字会说谎。
修法：渲染时对 name 做 `replace(/\s+/g, ' ')`，顺带解决纯空白文本节点白占一行。

**#2 —— 广告了用不了的 uid。** 无 `backendDOMNodeId` 的节点（InlineTextBox、
wikipedia 里 115 个 `StaticText "^ "`、bing 的无名 image）照样打印 uid，但
`{"$uid"}` 宏抛 `Unknown uid`，`click`/`fill` 抛 `not found`。这与「所有元素保留
uid」的承诺直接冲突 —— 承诺的前提是 uid **可用**。四条格式化规则能把占比压到 ~4%，
但压不到 0。

**#3 —— 快照不幂等。** 见上面 diff 章节的归因修正。这是 diff 阶段的硬前置。
修法：给无 backendId 的节点按 `nodeId` 做**确定性**编号，而不是取全局递增计数器。

**#4 —— `nodeMap` 无界增长。** `buildSnapshot` 的清理循环只遍历 `uidMap`，
无 backendId 的 uid 永不回收。长会话里是实打实的内存泄漏。

**#5 —— `LineBreak` 带 name 会被打印**（`IGNORED_ROLES` 只在「无名」时跳过，
而它的 name 是 `"\n"`）。hn 有 58 条只含空白 name 的行。建议把「IGNORED_ROLES
且 name 为纯空白」也算作无名。

**#6 —— `(empty page)` 分支不带表头**，与正常返回的结构不一致。影响小，
但需显式决定是有意还是遗漏。

### 修复状态

| #   | 缺陷                                            | 状态                                                                                                                                                                 |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `elementCount` ≠ 行数                           | ✅ 已修（`nameOf` 空白归一）                                                                                                                                         |
| 2   | 打印了解析不了的 uid                            | ⚠️ 大幅缓解：wikipedia 863 → 115、其余夹具 → 0。剩余的是 `StaticText "^ "` 一类无 DOM 节点的文本。它们现在带 `t` 前缀（区别于可解析的 `e` 前缀），本快照内确定性编号 |
| 3   | 快照非幂等                                      | ✅ 已修（无 backendId 的节点改为按本快照出现序确定性编号，不再取全局递增计数器）。全部 13 份夹具连拍两次逐字节相同                                                   |
| 4   | `nodeMap` 无界增长                              | ✅ 已修（每次快照重建 `nodeMap`；uid 的契约本就是「只在最新快照内有效」）                                                                                            |
| 5   | `LineBreak` 带 name 被打印                      | ✅ 已修（归入 `LAYOUT_ONLY_ROLES`，无条件跳过）                                                                                                                      |
| 6   | `(empty page)` 分支不带表头                     | ⬜ 未动，待显式决定                                                                                                                                                  |
| 7   | 归一后无名的 `StaticText` 渲染成只有 uid 的空行 | ✅ 已修：只剩 uid、无 role 名/无 name/无属性的行一律跳过，子节点顶上来                                                                                               |

性能：wikipedia（7259 节点）单次 19ms。R4 的聚合是**自底向上一次算完**
（`subtreeText` / `subtreeBlocked` 两张表），不是每个节点重走子孙 —— 后者是 O(n²)。
