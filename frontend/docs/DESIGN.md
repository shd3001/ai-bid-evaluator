# 评审台 · 前端设计契约

> 本文件是 `frontend/` 的视觉与交互契约。任何组件、页面、样式在实现前先对齐这里；改动契约须同步修改本文件。

## 1. 方向（一句话）

**评审台不是"数据看板"，而是一张工作台：每一条结论都必须能追到原文的哪一页、哪一段。**

对象的"世界观"来自招投标材料本身：招标文件条款编号、投标文件页码、评分表分值、资格条款、版本与过期。界面语言从这些实物里长出来，而不是从通用仪表盘模板里长出来。

- 三态资格审查是主线：`passed / failed / needs_review`，缺信息不得隐式转通过。
- 数值（分值、金额、版本、ID、时间）按"账本"规格呈现：等宽体、`font-variant-numeric: tabular-nums`、右对齐、十进制字符串原样显示。
- 过期（stale）与执行状态（status）是两条独立信息，界面上不得合并成一个"状态"。

### 反模式（明确禁止）

- 近黑底 + 单一荧光绿；近黑底 + 单一朱红大色块铺满页面。
- 通栏粘顶导航 + 三等分对称卡片网格。
- 纯黑白大色块、零圆角的"报纸"排版。
- 渐变徽章、发光边框、emoji 图标、装饰性插画。
- 为"活跃度"造百分比：`known_steps` 未知总数时不得显示百分比进度。

## 2. 色板（墨 · 纸 · 印）

冷调纸底，不是暖米色。强调色是"印青"（印章青绿），仅用于主操作与当前态；结论色只在结论处出现，绝不铺满背景。

| 令牌 | 值（浅色） | 用途 |
|---|---|---|
| `--ink` | `#111820` | 正文、标题 |
| `--ink-2` | `#3B4650` | 次级正文 |
| `--ink-3` | `#6D7883` | 说明、元信息 |
| `--ink-4` | `#9AA4AD` | 占位、禁用 |
| `--paper` | `#F4F5F2` | 页面底（冷调纸） |
| `--surface` | `#FFFFFF` | 卡片内芯 |
| `--surface-2` | `#EDEFEA` | 内芯之下的凹槽/表头 |
| `--line` | `#DEE2DC` | 发丝分隔线 |
| `--line-strong` | `#C6CCC6` | 强调分隔线 |
| `--seal` | `#0E6B5C` | 印青：主操作、当前态、链接 |
| `--seal-weak` | `#E2EFEB` | 印青底 |
| `--seal-ink` | `#0A4E44` | 印青文字/hover |
| `--pass` | `#2F7D5A` | 通过 |
| `--fail` | `#B4362C` | 失败/拒绝/过期下载 |
| `--review` | `#8A6410` | 待复核（芥黄） |
| `--pending` | `#5C6873` | 未开始/已取消 |
| 中性底 | `--pass-weak #E6F0E9` / `--fail-weak #F7E7E4` / `--review-weak #F5EEDC` / `--pending-weak #E9ECEE` | 结论底色 |

深色主题共用同一组语义名，按 `[data-theme="dark"]` 覆盖：`--paper #0F1416`、`--surface #161C1F`、`--surface-2 #1E2528`、`--line #2A3236`、`--ink #E8ECEA`、`--seal #3FA894`、`--seal-weak #143029`、`--ink-2 #B7C0BE`、`--ink-3 #8B9593`、`--pass #55C08A`、`--fail #E8776A`、`--review #D9AE55`、`--pending #93A0A6`，其余按同族推导。

深色不是"另一套设计"，只是把同一组语义令牌换值。生效方式：`frontend/src/utils/theme.ts` 里 `initTheme()` 在首屏渲染前把选择写到 `<html data-theme>`（选择存 `localStorage` 键 `review-desk.theme.v1`，取值 `light | dark | system`），顶栏 `ThemeToggle` 按 `跟随系统 → 浅色 → 深色` 三态循环。**主题只影响呈现，不参与任何业务判断。**

圆角：`--r-card 20px`、`--r-core 16px`、`--r-sm 10px`、`--r-pill 999px`。
阴影：只允许"双包边"内阴影 + 极轻环境阴影，禁止深色硬投影。
`--shadow-shell: 0 1px 2px rgba(17,24,32,.05), 0 8px 24px -18px rgba(17,24,32,.25)`；
`--shadow-core: inset 0 1px 0 rgba(255,255,255,.7)`（深色主题改为 `inset 0 1px 0 rgba(255,255,255,.06)`）。

## 3. 字体（只用系统字体栈，不引用任何网络字体）

字体栈本身写成 CSS 变量，Windows / macOS / Linux 都能落到本地已有字体：

- `--font-cjk: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Hiragino Sans GB", sans-serif`
- `--font-ui: "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, -apple-system, var(--font-cjk)`
- `--font-display: "Segoe UI Variable Display", "Segoe UI", ui-sans-serif, system-ui, var(--font-cjk)`
- `--font-ledger: "Cascadia Mono", Consolas, "SF Mono", ui-monospace, "Courier New", monospace`（数值、ID、哈希、时间、条款编号）
- `--font-serif-cjk: "Songti SC", SimSun, "Noto Serif CJK SC", "Source Han Serif SC", serif`（仅用于报告的封面题名与文档引文）

字阶（1.25 比例，`clamp()` 只在页面级标题使用）：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--fs-display` | `clamp(1.9rem, 1.4rem + 1.6vw, 2.6rem)` | 页面主标题 |
| `--fs-h1` | `1.5rem` | 区块标题 |
| `--fs-h2` | `1.15rem` | 卡片标题 |
| `--fs-body` | `0.95rem` | 正文 |
| `--fs-sm` | `0.85rem` | 次级 |
| `--fs-xs` | `0.78rem` | 元信息、表格 |
| `--fs-micro` | `0.7rem` | 眉标（配 `letter-spacing: .14em`，大写用拉丁） |

关键排版规则：所有数字容器加 `.ledger-num`（等宽 + tabular-nums + 右对齐）；ID/哈希加 `.mono` 并允许省略号截断 + `title` 全量；分值展示必须保留后端十进制字符串原样（不得 `Number()` 后自行四舍五入）。

## 4. 布局

- 页面内**没有常驻左侧栏**。三段式：顶栏（`--h-top 56px`）→ 阶段带（`--h-phase 46px`）→ 内容区（`--page-max 1280px` 居中，左右 `clamp(16px, 3vw, 40px)`）。
- 桌面内容网格：`grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr)`，证据/上下文列在右；`<= 1024px` 折叠为单列。
- 卡片统一"双包边"（Doppelrand）：外壳 `bg: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-card); padding: 6px; box-shadow: var(--shadow-shell)`；内芯 `bg: var(--surface); border-radius: var(--r-core); box-shadow: var(--shadow-core)`。主操作按钮为药丸形，尾部图标放在独立圆形内壳里。
- 空态、错误态、加载态都写具体文案：空态说清下一步做什么，错误态说清发生了什么与如何恢复（含 `request_id`）。禁止"暂无数据"这类无指向文案。
- 最低质量底线：键盘可达（`:focus-visible` 用 `outline: 2px solid var(--seal); outline-offset: 2px`）、`prefers-reduced-motion: reduce` 时关闭入场动画与过渡、可读性对比度 AA。

## 5. 签名元素：证据榫（Evidence Tenon）

**界面上最独特、最该被记住的东西：每条结论旁的可点击"证据榫"。**

- 结构：一个窄药丸，内含定位符（`p.12` / `表3 行5-9` / `块 ab12cd`）+ 引文前 ~18 字；左侧有一段 2px 竖线（榫舌）连到结论。
- 三态视觉：有证据（实线榫 + 印青）、证据不足（虚线榫 + `--review`）、无证据（缺榫，留白缺口 + `--fail`）。
- 交互：点击打开右侧证据抽屉（`EvidenceDrawer`），抽屉内按 `document_id` 分组，`chunk_id` 高亮并滚动到视口；`Esc` 关闭；关闭后焦点回到那个证据榫。
- 数据来源只有 `EvidenceRef`：`{document_id, document_hash, chunk_id, quote, page, sheet, row_start, row_end, column_start, column_end}`。**不得按文件名关联，不得自行推断页码或引文。**
- 组件：`frontend/src/components/EvidenceTenon.tsx` + `EvidenceDrawer.tsx`。

## 6. 动效

- 只允许 `transform` / `opacity` 过渡（外加必要的 `background-color` / `border-color` 颜色过渡）。
- 缓动：`--ease-out: cubic-bezier(.32,.72,0,1)`；`--ease-in-out: cubic-bezier(.4,0,.2,1)`。禁止 `linear`（进度条等连续指示除外）。
- 入场：内容区块用 `translateY(8px) opacity 0 → 0/1`，160–240ms，`stagger` 40ms；`prefers-reduced-motion` 下全部取消。
- 状态变化（结论态、轮询更新）用 180ms 的色/位过渡，不用弹跳。

## 7. 文案规则

- 中文界面，句子用中文标点；按钮动词化并贯穿全流程（"提交评审" → 提示"已提交评审"）。
- 不写"暂无数据"。写"这个项目还没有材料。先上传招标文件，再上传各家投标文件。"
- 错误必须给出恢复路径，并显示 `request_id`（可复制）。
- 后端返回的分值、资格、排名、版本一律原样展示，前端不重算、不排序业务结论、不推断缺失字段。

## 8. 目录与职责（实现现状）

> 下面括号里是**实际落地位置**；与理想命名不同的地方以括号为准（例如证据组件合并在 `evidence.tsx`，没有各自单独成文件）。

```
frontend/src/
  api/         client.ts（fetch + 错误 + 分页游标 + 幂等键 + 演示解析器类型）、schema.ts（OpenAPI 生成类型）、mode.ts（live | demo 判定）、demo-source.ts（夹具 → 只读数据源）
  app/         App.tsx（入口 + 路由分派）、shell.tsx（AppShell / TopBar / PhaseRail / ConnectionBadge / ThemeToggle / AppErrorBoundary / ToastHub）、session.tsx（SessionProvider / ToastProvider）
  components/  core.tsx（Panel 双包边 / Button / VerdictBadge / RunStatusChip / StatusFlag / CopyId / EmptyState / describeError / ErrorNotice / Skeleton / Disclosure）
               evidence.tsx（EvidenceTenon / EvidenceTenonRow / EvidenceDrawer / EvidenceProvider）
               layout.tsx（Pagination / Tabs / DetailList / Labeled）
               scores.tsx（QualificationBoard / ScoreLedger / RuleRow）
               results.tsx（ResultView / NoticeList / detectNotices）
  views/       ProjectsView / ProjectDetailView / UploadView / DocumentView / RunCreateView / RunView / ReviewView / ReportView / OpportunityView / AboutView（含 NotFoundView）
  demo/        fixtures/**（python 导出，勿手改） + README.md（已知限制）
  styles/      tokens.css, base.css, app.css
  utils/       format.ts（时间/ID/分值格式化，绝不改数值）、router.ts（零依赖 hash 路由）、usePolling.ts, useAsync.ts、idempotency.ts、uploads.ts、theme.ts（浅色/深色/跟随系统）、cx.ts
```

未实现（原计划里列过，当前明确不做）：`ConfirmDialog`（用原生 `confirm` 之外只做了内联二次确认）、独立的 `a11y.ts`（无障碍规则直接写在组件里）。主题切换**已实现**为顶栏三态控件（`跟随系统 → 浅色 → 深色`），它只改 `<html data-theme>` 与 `localStorage`，不参与任何业务判断。

## 9. 与后端的边界（硬约束）

以下内容**必须由后端返回，前端不得实现**：分值计算、资格判定、排名、总分、报告版本号、stale 判定、复核是否允许、上游依赖顺序。前端只做：展示、原样回传（`expected_version`、`patch`、`Idempotency-Key`）、分页游标透传、轮询调度、错误映射。
