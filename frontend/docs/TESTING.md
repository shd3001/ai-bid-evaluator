# 前端截图 / 无障碍 / 走查工具（CDP，离线）

> 更新（2026-10-11）：第五阶段已在允许启动 Chrome 的本机执行环境完成真实浏览器验收，11 路由、44 张截图通过。结果位于 `.verification/phase5/`，复跑命令见 [第五阶段指南](../../docs/phase-5-acceptance.md)。下文第 6、8、10 节的 BLOCKED 记录为第四阶段历史环境记录，不代表当前验收状态。

本目录工具用**本机 Chrome 的 DevTools Protocol** 做截图、走查与设计契约审计：不装 playwright / selenium / puppeteer，不联网，只用 Node 内置模块 + Node 24 自带的全局 `WebSocket`。

适用场景：把「页面能渲染、无控制台错误、徽标/分值/无证据标记符合设计契约、reduced-motion 生效」这类**设计验收**变成可复跑的命令与机器可读证据。

- 工具目录：`frontend/tools/`
- 默认产物目录：仓库根的 `.verification/`（`shots/`、`a11y/`、`walkthrough/`、`selftest/`）
- 页面清单：`frontend/tools/pages.json`

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| Node | 本机可用：`C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0，全局 `WebSocket` 可用） |
| Chrome | 自动按顺序找：`C:\Program Files\Google\Chrome\Application\chrome.exe` → `Program Files (x86)` → `%LOCALAPPDATA%` → Edge → macOS/Linux 常见路径；也可 `--chrome <path>` 显式指定 |
| 离线开关 | 跑任何 vite 相关命令前设 `$env:DSH_NO_NET_USE="1"`（本仓库 vite 的离线补丁依赖它） |
| 依赖 | **零第三方依赖**，无需 `npm install` |

> 术语：下文所有命令都假设当前目录是 `frontend/`（即 `cd frontend` 之后）。

---

## 2. 三条命令（可直接粘贴）

推荐入口 `walkthrough.mjs`：它**自己起静态服务器**托管 `frontend/dist`，不需要你先开 dev/preview。

```powershell
cd frontend
$env:DSH_NO_NET_USE="1"
& "C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\walkthrough.mjs
```

只想截图：

```powershell
& "<node.exe>" tools\screenshot.mjs --base http://127.0.0.1:5173 --out ..\.verification\shots --theme light,dark --width 1440,390
```

只做无障碍 + 设计契约审计：

```powershell
& "<node.exe>" tools\a11y-contract.mjs --base http://127.0.0.1:5173 --out ..\.verification\a11y
```

一键自测（夹具站点 + 静态服务器 + 真跑上面两个工具 + 断言，不需要先起任何服务）：

```powershell
& "<node.exe>" tools\selftest.mjs
```

只探测「本机到底能不能起 Chrome/CDP」：

```powershell
& "<node.exe>" tools\cdp.mjs --doctor
```

`--base` 与自起服务器二选一：给了 `--base` 就完全用你的服务器；不给就自己起。

---

## 3. 工具与产物

### 3.1 `walkthrough.mjs` — 端到端走查（推荐）

对 `tools/pages.json`（或 `--pages`）里的每一页，按 `视口宽度 × 主题` 组合各开一个页面：

1. 审计页面结构（`#root` 是否有子节点、是否出现 `#app-error` 错误边界、h1、可见文本量）；
2. 截图到 `<out>/shots/<name>-<width>-<theme>.png`；
3. 另开一个 `prefers-reduced-motion: reduce` 的页面复测动画（`document.getAnimations()` 里还有没有在跑的 `transform`）；
4. 汇总每页的 console error / 页面异常 / 请求失败；
5. 写出 `<out>/walkthrough.json`（机器可读）与 `<out>/walkthrough.md`（人读，含「未跑成的断言」「证据边界」两节）。

主要参数：`--base`、`--server static|vite-dev|vite-preview`、`--dist`、`--pages`、`--pages-file`、`--out`、`--width`、`--theme`、`--full`、`--allow-missing`、`--chrome`、`--timeout`、`--port`。

页面「尚未实现」（例如只渲染占位文案、`#root` 空）会被判为 `missing` 并写进报告，**不会**让工具崩掉；要让它不计入退出码就加 `--allow-missing`。

### 3.2 `screenshot.mjs` — 截图

产物：`<out>/<name>-<width>-<theme>.png` + `<out>/screenshots.json`
（每行含 url / title / status / reason / shot / shotBytes / root / h1 / implemented / consoleErrors / pageErrors / requestFailures / httpErrors / durationMs，以及 `totals` 汇总。）

- `--width 1440,390`：高度按 `1440→900`、`390→844` 推导，也可 `--height` 强制。
- `--theme light,dark`：注入 `localStorage` 的主题键后再加载；`default` 表示不覆盖页面默认主题。**本应用的真实键是 `review-desk.theme.v1`**（见 `frontend/src/utils/theme.ts`，取值 `light|dark|system`；`system` 由 `prefers-color-scheme` 解析），工具已把它排在第一顺位，其余键 `theme` / `dsh-theme` / `app-theme` 只是兜底兼容。注意：应用启动时 `initTheme()` 会用真实键的值重写 `<html data-theme>`，所以只设 `data-theme`、不写这个键的话，深色会在启动后被"改回系统主题"——真要验证深色，请用 `--theme dark`（工具同时写键与属性）。
- `--full`：整页截图（默认只截视口）。
- `--reduced-motion`：以 reduce 偏好截图。

### 3.3 `a11y-contract.mjs` — 无障碍 + 设计契约审计

逐页注入一段自包含审计脚本，输出 JSON（`<out>/a11y-contract.json`）与 stdout 逐项 `[PASS/FAIL/WARN/INFO/SKIP]` 清单。检查项：

| 检查项 id | 说明 | 失败即非 0 退出 |
| --- | --- | --- |
| `interactive-name` | 可交互元素（button/a/input/select/`[role]`）是否有可达名称 | 是 |
| `img-alt` | `img` 是否缺 `alt` | 是 |
| `html-lang` | `<html lang>` 是否存在 | 是 |
| `focus-visible` | 是否有 `:focus-visible` 规则；有 `outline:none` 又无焦点样式则判失败 | 是（无焦点样式且存在 `outline:none`） |
| `reduced-motion-css` | 是否存在 `@media (prefers-reduced-motion: reduce)` 规则 | 否（warn） |
| `verdict-values` | `[data-verdict]` 取值是否属于 `passed/failed/needs_review/pending` | 是 |
| `ledger-num` | 疑似分值/金额节点是否命中 `.ledger-num`（启发式） | 否（warn，需人工确认） |
| `tenon-missing` | `.tenon--missing` 命中数（是否有「无证据结论」依赖后端数据） | 否（info） |
| `reduced-motion` | reduce 下是否仍有运行中的 `transform` 动画 | 是 |
| `page-impl` | 页面是否已实现（未实现时上述契约项记 skipped） | 否 |
| `console-errors` | 控制台是否有 error | 是 |

### 3.4 `tools/pages.json` — 页面清单

```json
{
  "defaults": { "widths": [1440, 390], "themes": ["light", "dark"] },
  "pages": [
    { "name": "projects", "path": "#/projects", "title": "项目列表" }
  ]
}
```

- 条目取 `path` / `hash` / `url` 三者之一；`#` 开头会拼到 `--base` 后。
- 清单当前共 **11 条**（与 SSR 走查的 11 条路由对齐）：`projects`、`project-detail`、`project-upload`、`run`、`run-review`、`run-report`、`run-new`、`document`、`not-found`、`about`、`opportunity`。
- 需要真实 id 的路由（如 `#/runs/<id>/report`）带 `"needsParam": true`；清单里填的是 **demo 夹具里真实存在的 id**。事实来源是 `frontend/src/demo/fixtures/index.json`（夹具 id 的定义处）；同一份 id 也能在 SSR 走查产物 `frontend/.verification/ssr/walkthrough.json`（人读/机器读汇总）与同目录 `<route>.html` 里看到。夹具变了就用 `--pages` 覆盖或直接改文件。
- 临时用 `--pages "projects=#/projects,report=#/runs/<run_id>/report"` 覆盖，不必改文件。

### 3.5 `tools/selftest.mjs` — 一键自测

`node tools/selftest.mjs` 会：生成两页夹具站点（**一页合规、一页故意违规**）→ 用 Node 内置 http 起静态服务器 → 拉起 `screenshot.mjs` 与 `a11y-contract.mjs` → 断言 PNG 是合法 PNG 魔数、合规页 0 项 FAIL、违规页至少被捕获到 3 项 FAIL（证明检查器不是橡皮章）→ 在 Node 里直接编译两段注入脚本并跑判定逻辑（这部分**不需要浏览器**）。

退出码：`0` 全部通过；`1` 有断言失败；`2` 环境阻断（本终端起不了 Chromium，见第 6 节）。

### 3.6 `tools/cdp.mjs` — 底座 / `--doctor`

`cdp.mjs` 是零依赖 CDP 客户端（WebSocket 多路复用、`Page.loadEventFired` 等待、`Runtime.evaluate`、设备尺寸覆盖、整页截图、超时与错误上下文），另外三个工具都基于它。直接运行它等于自检：

```
node tools/cdp.mjs --doctor
```

会打印 node 版本、全局 `WebSocket` 是否可用、Chrome 候选路径存在性、解析结果，然后真的尝试启动一次并连 CDP，最后给出 ✓/✗ 与失败诊断。

---

## 4. 设计契约断言（验收口径）

| # | 设计契约 | 落地检查项 | 能否自动判定 |
| --- | --- | --- | --- |
| ① | 每个结论徽标都落在 `[data-verdict]` 的四个值之一 | `verdict-values` | 能（页面内直接读属性；非法取值 ⇒ FAIL） |
| ② | 凡显示分值/金额的节点都命中 `.ledger-num` | `ledger-num` | **只能启发式**：工具比对「看起来像分值/金额的裸数字文本」与 `.ledger-num` 覆盖情况，命中差异只记 WARN，需人工确认 |
| ③ | 无证据的结论必须出现 `.tenon--missing` | `tenon-missing` | **不能**：工具只能数 `.tenon--missing` 出现次数；「哪些结论属于无证据」依赖后端数据，记 INFO 需人工核对 |
| ④ | `prefers-reduced-motion: reduce` 下不得有运行中的 transform 动画 | `reduced-motion` | 能（`Emulation.setEmulatedMedia` + `document.getAnimations()`） |

`a11y-contract.mjs` 的 `--pages` / `pages.json` 决定了断言覆盖哪些路由；未实现路由的契约项会记 `skipped`（而不是「通过」）。

### 4.1 四条契约的实现现状（诚实口径）

| # | 契约 | 本目录工具的检查项 | 状态 |
| --- | --- | --- | --- |
| ① | `[data-verdict]` 四值合法 | `verdict-values` | **已实现**（读属性直接判定非法取值） |
| ② | 分值/金额都命中 `.ledger-num` | `ledger-num` | **部分实现**：只能启发式比对「像分值/金额的裸数字」与 `.ledger-num`，命中差异记 WARN，需人工确认 |
| ③ | 无证据结论出现 `.tenon--missing` | `tenon-missing` | **未实现自动判定**：只能数 `.tenon--missing` 出现次数，「哪些结论属于无证据」依赖后端数据，记 INFO |
| ④ | reduce 下无运行中的 transform 动画 | `reduced-motion` | **已实现**（`Emulation.setEmulatedMedia` + `document.getAnimations()`） |

另：`--reduced-motion` 之外的动画判定都由 `walkthrough.mjs` 的 reduce 复测页承担；`@media (prefers-reduced-motion: reduce)` 规则是否存在由 `reduced-motion-css` 统计（WARN 级）。

补充（Lead 侧独立静态审计，位于 `.verification/node-tools/`，可与上面的运行时断言交叉印证）：

- `css-contract.mjs`：类名对账，当前 **0 缺失**；但 `[data-verdict]` 相关徽标在 demo 渲染里**未被覆盖**——评标结果在 run 页只以 Disclosure 呈现，所以 ① 目前缺少真实渲染样本。
- `theme-check.mjs`：核对深色块确实把 `--paper/--surface/--ink/--seal/--line/--pass/--fail/--review` 换成另一套值，并做 `data-theme` 写入读回；当前 **8/8 令牌两套取值均不同**、problems 为空。（对应的应用侧实现是 `frontend/src/utils/theme.ts` 的三态切换 `跟随系统 → 浅色 → 深色`，键 `review-desk.theme.v1`。深色的**视觉**效果仍只有本目录的 `--theme dark` 截图能证明——本沙箱拿不到。）
- `encoding-check.mjs` / `text-check.mjs`：60 个源文件全部合法 UTF-8、**0 处乱码**、**0 个未定义设计令牌**。

---

## 5. 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 全部通过（没有 FAIL 项，也没有环境阻断） |
| `1` | 有失败项（无障碍/契约 FAIL，或截图组合失败） |
| `2` | 用法错误（缺 `--base` 等）或环境阻断/致命错误（找不到 Chrome、Chrome 起不来、服务器起不来） |

`walkthrough.json` / `screenshots.json` / `a11y-contract.json` 是给 CI 或后续人工复查用的机器可读证据。

---

## 6. 已知限制：**在本仓库当前的受限沙箱里，Chromium 一定起不来**

这不是本工具的参数问题，也不是 Node/stdio 问题：受限沙箱同时禁止了 `OpenProcess` 与**命名管道**，而 Chromium 的多进程 IPC 必须按名字打开管道。实测（Chrome 154、Edge、Electron 44 / Chromium 152 全部同样失败）：

```text
[1004/211443.666:ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:421] OpenProcess: 拒绝访问。 (0x5)
[29656:9588:1004/211443.738:FATAL:mojo\public\cpp\platform\platform_channel.cc:112] Check failed: . : 拒绝访问。 (0x5)
[1004/211443.738:ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:142] crash server failed to launch, self-terminating
```

Chrome 以 `exitCode=4294930433`（`0xFFFF7001`）立刻退出，连 `/json/version` 都来不及监听。工具会把这三点原文和一句诊断直接打在错误里，不用你去翻日志。

**因此：本仓库当前没有任何 PNG 产物，也没有跑过真实的页面审计。** 想拿到真实截图/审计证据，请在**未受限的普通 PowerShell/终端**里执行第 2 节那一条 `walkthrough.mjs` 命令（它会自己起服务器），产物落在 `.verification/walkthrough/`。

> 请勿把「工具齐全 + 逻辑自测通过」表述为「截图已验收通过」—— 二者不是一回事。本沙箱能证明的只有：夹具站点、静态服务器、参数解析、注入脚本可编译、判定逻辑会抓错；不能证明的只有：真实浏览器渲染与截图。

工具侧已做的规避与可诊断性：

- 子进程 stdio 用 `"ignore"` 或**重定向到文件 fd**（沙箱下用管道捕获子进程输出会 `EPERM`）；
- Chrome 自身日志通过 `--enable-logging=stderr` 落到 `<profile>/chrome-stderr.log`，失败时把末尾若干行与诊断一起抛出；
- Chrome profile 默认放在 `%TEMP%\dsh-cdp-profile\run-*`，成功退出时自动删除，不污染工作区（失败时保留以便看日志）；
- 关闭流程：逐页关 → 关浏览器 → 超时兜底 `taskkill /PID <pid> /T /F` → 删 profile。

---

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| 错误里出现 `crashpad` / `OpenProcess: 拒绝访问` / `platform_channel` / `EPERM` | 当前终端在受限沙箱里，Chromium 起不来。换未受限终端重跑，别改参数 |
| `找不到 Chrome` | 用 `--chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"`，或先 `node tools/cdp.mjs --doctor` 看候选列表 |
| 某个路由被记为 `missing` | 该路由没渲染出内容（`#root` 空 / 只有占位文案），或页面清单里的 id 不是 demo 夹具里真实存在的 id；修正 `pages.json`，或加 `--allow-missing` 让它不影响退出码 |
| `等待 Chrome 调试端口超时` | 端口被占用/Chrome 启动极慢；提高 `--timeout`，或 `--doctor` 确认能起 |
| 截图空白/高度不对 | 加 `--full`；确认 `--width` 与 `defaultHeightFor` 推导的高度合适（1440→900、390→844） |
| 想让脚本读 JSON | `walkthrough.json` / `screenshots.json` / `a11y-contract.json`；`--json` 可换文件名 |

---

## 8. 沙箱内可达的运行时验证：SSR 走查（与本目录的 CDP 走查互补，**不是同一件事**）

因为本沙箱起不了任何浏览器（第 6 节），仓库另有一条**不依赖浏览器**的运行时通路，由 `frontend/scripts/` 提供：

```powershell
cd frontend
$env:DSH_NO_NET_USE="1"
& "C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "scripts\ssr-walkthrough.mjs"
# 实际命令以 frontend/README.md「命令 5」为准（node 路径用你本机那个）
```

- 实现：`frontend/scripts/ssr-walkthrough.mjs` + `frontend/scripts/dom-shim.mjs` —— 真 `react-dom/client` + Vite SSR 管线 + 自写 DOM shim，在 Node 进程里把**真组件树**（含异步取数）渲染出来，靠 HTML 文本与选择器计数做断言。
- 产物：`frontend/.verification/ssr/<route>.html`（已内联 CSS，可离线双击查看）、`frontend/.verification/ssr/walkthrough.json`（汇总，顶层 `generated_at/mode/routes_total/routes_ok/asserts_total/asserts_failed/pages`；`pages[]` 每项含 `route/path/ok/bytes/counts/error`）。两层目录都要，早期版本曾在 `.verification/` 根下平铺写过同名文件，现已统一到 `ssr/` 子目录。
- **已知通过项（Lead 实测）**：11/11 条路由渲染成功、47/47 条断言通过。它验证「真实数据下组件树不崩 + 断言与文案契约成立」。
- **它不验证**：CSS 布局、视觉像素、指针交互、主题切换后的外观、`prefers-reduced-motion` 的实际动画行为 —— 这些只有第 2 节的 CDP 走查（在未受限终端）才能给证据。
- 它在实现期抓到过一个真 bug：demo 模式下 `GET /runs/{id}/reviews` 被按路径判定误当成写操作拦下，导致复核页恒显示空列表；已修（`DemoResolver` 增加 method 形参）。

| | CDP 走查（`tools/walkthrough.mjs` 等） | SSR 走查（`scripts/ssr-walkthrough.mjs`） |
| --- | --- | --- |
| 需要浏览器 | 是（本沙箱**不可用**） | 否 |
| 跑什么 | 真 Chrome 里的页面、截图、主题/视口/reduced-motion、控制台错误 | Node 里的真组件树 + HTML 断言 |
| 能给的证据 | 视觉与设计验收证据 | 组件树/文案契约证据 |
| 本沙箱结果 | **BLOCKED**（Chromium 无法启动） | **通过**（11/11 路由、47/47 断言） |

---

## 9. 证据边界

- **能证明**：页面渲染出了什么、`#root` 是否挂载、有没有错误边界、控制台/请求错误、各视口与主题下的截图、`[data-verdict]` 取值、`.ledger-num` / `.tenon--missing` 命中情况、reduce 下是否仍有动画、键盘焦点样式是否存在。
- **不能证明**：业务逻辑正确性、数据口径、后端契约、评分算法是否合理、无证据结论的判定是否正确（②③ 见第 4 节）。
- 截图与 a11y 报告是**设计验收证据**，不等于功能正确性验收；功能正确性仍需后端/单元测试与人工复核。

---

## 10. 本次实测记录（用于复现）

环境：本仓库当前受限沙箱，Chrome 154.0.8037.95，Node v24.21.0。

| 命令 | 结果 |
| --- | --- |
| `node tools/selftest.mjs` | `PASS 9 / FAIL 0 / SKIP 3`，退出码 **2 = BLOCKED**（夹具站点、静态服务器、注入脚本可编译、判定逻辑抓错全部通过；PNG 产出因 Chromium 无法启动而跳过） |
| `node tools/cdp.mjs --doctor` | 退出码 **1**：Chrome 候选能找到、解析成功，启动后 `exitCode=4294930433` + 上文 stderr 原文 + 诊断 |
| `node tools/walkthrough.mjs` | 退出码 **2**：自起静态服务器成功（`服务器自检：HTTP 200，首页 474 字节（453 字符）`——**当次构建的实测值**，重建后随产物变化；工具这里报的是 UTF-8 **字节数**，字符数更小是因为页面含中文），随后 Chrome 启动失败并打印 stderr 原文 |
| `node tools/screenshot.mjs --help` / `a11y-contract.mjs --help` / `walkthrough.mjs --help` | 均退出码 **0**，正常打印帮助 |
| `node scripts/ssr-walkthrough.mjs`（Lead 侧，第 8 节） | **通过**：11/11 路由渲染成功、47/47 断言通过，产物 `frontend/.verification/ssr/` |

失败原文与诊断保存在：`.verification/selftest/selftest-screenshot.log`、`.verification/selftest/selftest-a11y.log`。
