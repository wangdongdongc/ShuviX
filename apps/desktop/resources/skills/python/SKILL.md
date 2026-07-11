---
name: python
description: "ShuviX 内置 Pyodide WebAssembly Python 解释器，通过 `shuvix python` CLI 调用（行为贴近 `python3` 原生）。**当客户电脑没有装 Python，或者你需要 ShuviX 预装的科学/办公包（pymupdf / python-pptx / openpyxl / python-docx / pillow / pyyaml / lxml / beautifulsoup4 / regex / python-dateutil / xlrd / python_calamine / xlsxwriter）时**——加载本 skill 并通过 `bash` 工具调用 `shuvix python`。原生 `python3` 已经可用且任务不依赖预装包时，直接走 bash + `python3` 更轻量，本 skill 不必加载。"
---

# `shuvix python` —— Pyodide 内置 Python

ShuviX 自带一个 WebAssembly 版本的 Python 解释器（Pyodide），通过 CLI `shuvix python` 调用。用法子集贴近原生 `python3`：所有调用都需要走 `bash` 工具发起。

```bash
shuvix python -c "print(1+1)"
shuvix python -c "import sys; print(sys.argv)" foo bar
shuvix python /abs/path/script.py arg1 arg2
shuvix python -m base64 -h
shuvix python -V         # 打印版本号
shuvix python --help     # 完整用法
echo 'print("hi")' | shuvix python -
```

## 何时用 `shuvix python` vs 系统 `python3`

| 场景 | 选择 |
|---|---|
| 用户机器有 `python3` 且任务不需要预装包 | **直接** `bash`→`python3 -c "..."`（更轻量） |
| 用户机器没装 Python，或不确定 | `shuvix python` |
| 需要 pymupdf / python-pptx / openpyxl / python-docx / pillow 等预装包 | `shuvix python`（这些包已离线打包，不必 pip 安装） |
| 需要 C 扩展（multiprocessing / ctypes / 大部分 numpy 二进制依赖） | 只能用 系统 `python3`（Pyodide 限制） |

不要尝试用 `which python3` 主动检测；直接按上面的语义选。如果系统 python3 不存在，bash 会报错，那时再切到 `shuvix python` 重试。

## 预装包清单（直接 `import` 即可）

办公文档：`pymupdf` (PDF)、`docx` (Word, from python_docx)、`pptx` (PowerPoint, from python_pptx)、`openpyxl` (Excel xlsx 读写)、`xlrd` (Excel xls 读)、`python_calamine` (高速 Excel 读)、`xlsxwriter` (Excel xlsx 写)、`PIL` (图像, from pillow)

数据处理：`yaml` (from pyyaml)、`bs4` (HTML, from beautifulsoup4)、`lxml`、`cssselect`、`regex`、`dateutil` (from python_dateutil)、`pytz`

需要额外的纯 Python 包时：在代码里用 `micropip` 安装（同 session 内的后续 `shuvix python` 调用可复用 module cache，因为 Pyodide worker 在 session 期内长驻）。

```bash
shuvix python -c "
import micropip
await micropip.install('requests')
import requests
print(requests.get('https://httpbin.org/get').status_code)
"
```

注意：**C 扩展包（含 numpy 的某些发行版、scipy、pandas 二进制依赖）通常装不上**，micropip 只接受 pure-Python wheels 或 Pyodide 重新编译过的 wheel。

## 重要语义差异（与 cpython 不一致的地方）

1. **每次调用 globals 全新**：`shuvix python` 不是 REPL，没有跨调用的变量持久态。第一次调用里 `x = 42`，第二次调用 `print(x)` 会报 NameError。多步骤工作流写成一个完整脚本一次跑完，或者把中间结果落盘到文件。
2. **`sys.modules` 缓存在 worker 进程内保留**：同 session 内已经 import 过的模块二次 import 立刻命中，不会重新加载——这意味着 micropip 装的包只需要装一次。
3. **沙箱由项目读写边界自动约束**：工作目录可读写，引用目录按各自的 access 配置决定可读/可写；写入只读目录会抛 `PermissionError`。**不要**试图突破。
4. **没有交互式 stdin**：能通过 pipe 传入完整脚本（`shuvix python -`）或文件，但不能从 stdin 实时读用户输入。
5. **输出不流式**：长时间运行不要期待实时打印；所有 stdout/stderr 在进程退出后一次性返回。

## 复用 skill 自带的 .py 模块（PYTHONPATH 用法）

如果 skill 目录下有 `.py` 辅助库（例如某个 skill 的 `templates/slides.py`），通过 **PYTHONPATH** 让它可 import，**不要**把整段源码拷进 `-c`：

```bash
PYTHONPATH=/absolute/path/to/skill-dir/templates shuvix python -c "
from slides import cover_slide, Presentation
prs = Presentation()
cover_slide(prs, title='Hello', subtitle='Demo')
prs.save('out.pptx')
"
```

skill 目录会在 PYTHONPATH 解析时被自动以只读形式挂载到 Pyodide 文件系统，可直接 `import`。

## 退出码

- `0` 成功
- 非 0：异常（traceback 进 stderr）；`sys.exit(N)` 透传 N
- `2`：CLI 参数错误（如 `-c` 后面没跟代码）

## 调试小贴士

- 出错时先看 stderr 里的 traceback；它就是 Python 真实抛出的，没经过包装
- 想看 sys.path 当前内容：`shuvix python -c "import sys; print('\n'.join(sys.path))"`
- 想看预装包是否能 import：`shuvix python -c "import pymupdf; print(pymupdf.__version__)"`
