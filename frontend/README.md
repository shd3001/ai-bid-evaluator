# 评审台（frontend）

招投标辅助评审的 React 前端。**只做展示与提交**：分值计算、资格判定、排名与推荐集合、报告版本与失效（stale）判断全部由后端给出，前端不重算、不推断、不兜底。

- 设计取舍与反模式清单：`frontend/docs/DESIGN.md`
- 完全离线的依赖来源与构建约束：`frontend/docs/OFFLINE.md`
- 截图 / 走查 / 可访问性验收：`frontend/docs/TESTING.md`（由验收工具 `frontend/tools/**` 支撑）
- 第五阶段真实 HTTP / 浏览器联调与启动指南：[验收指南](../docs/phase-5-acceptance.md)。

## 技术栈

| 项 | 版本 | 说明 |
| --- | --- | --- |
| React / React DOM | 19.3.0 | 无路由库、无状态库、无 UI 框架 |
| TypeScript | 5.9.3 | `strict` + `noUnusedLocals/Parameters` + `verbatimModuleSyntax` |
| Vite | 8.3.0 | `@vitejs/plugin-react` 6.1.1 |

零运行时依赖之外的第三方包：**没有**。哈希路由、轮询、幂等键、时间与十进制格式化都是 `src/utils/**` 里的小模块。

## 目录

```
src/
  api/          client.ts（后端契约唯一出口）、schema.ts（由 openapi.json 生成）、mode.ts、demo-source.ts
  app/          App.tsx（入口/路由分派）、shell.tsx（外壳、错误边界）、session.tsx（会话与 toast）
  components/   core / evidence / layout / scores / results
  demo/         离线夹具（由 scripts/export_frontend_fixtures.py 生成，勿手改）
  styles/       tokens.css（设计令牌）→ base.css（重置与工具类）→ app.css（布局、组件、视图）
  utils/        format / router / usePolling / useAsync / idempotency / uploads / theme / cx
  views/        Projects / ProjectDetail / Upload / Document / RunCreate / Run / Review / Report / Opportunity / About
```

## 开发与构建

```powershell
cd frontend

# 1) 离线环境必须带这个变量（Windows 沙箱下 Vite 的 `net use` 探测会 EPERM）
$env:DSH_NO_NET_USE = "1"

# 2) 开发服务器（Vite 会把 /api 代理到 http://127.0.0.1:8000，开发期同源、无 CORS 漂移）
& "C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "node_modules\vite\bin\vite.js"

# 3) 生产构建
& "C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "node_modules\vite\bin\vite.js" build

# 4) 类型检查（工具链来自 .verification/api-client-tools，见 docs/OFFLINE.md）
& "C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "..\.verification\api-client-tools\node_modules\typescript\bin\tsc" --noEmit -p tsconfig.json

# 5) 沙箱内的运行时走查（不需要浏览器：真 React + Vite 管线 + 自写 DOM shim）
& "C:\Users\21910\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "scripts\ssr-walkthrough.mjs"
```

`node` 路径可换成 PATH 里的 `node`；上文写全路径是因为本机 Node 由 DSH 运行时自带。

命令 5 会把 11 条路由在 Node 里真实渲染一遍（含异步取数），输出 `.verification/ssr/<route>.html`（已内联 CSS，可离线双击查看）与 `walkthrough.json`。它验证**组件树在真实数据下不崩、断言与文案契约成立**；它**不验证** CSS 布局、视觉与指针交互——那部分见 `docs/TESTING.md`。

## 两种运行模式

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| 在线 | 后端在 `127.0.0.1:8000` 且 `/api/v1/health/ready` 可达（默认） | 真实请求；所有写操作带 `Idempotency-Key` |
| 离线演示 | 启动探测失败自动回落，或显式 `#/projects?demo=1` / `?demo=0` 强制 | 读请求走 `src/demo/fixtures/**`；写操作一律拒绝并提示需要真实后端 |

演示横幅会显示回落原因（`healthReason`）与后端地址，演示数据只读。

主题与运行模式无关：顶栏有**三态主题控件**（跟随系统 → 浅色 → 深色），选择存 `localStorage`（`review-desk.theme.v1`），首屏渲染前就写到 `<html data-theme>`，因此深色偏好下不会先闪一帧白底。它只改呈现，不参与任何业务判断。

## 与后端契约有关的硬性约定

- 分页统一 `limit`（默认 20，最大 100）+ 不透明 `cursor`，响应 `{items, next_cursor}`；游标原样回传。
- 轮询：前台 2 秒、后台标签页 10 秒；进入 `succeeded / failed / cancelled / awaiting_review` 立即停止自动轮询，失败后按 3s→15s 退避。
- 未知总步骤（`known_steps` 为空）时**不估算百分比**，只列已知步骤。
- 写请求（创建运行 / 重试 / 取消 / 复核）必须带 `Idempotency-Key`：同键同内容返回同一结果，同键不同内容会 409；内容指纹变化时自动换新键（`src/utils/idempotency.ts`）。
- 版本冲突（409）不自动覆盖：提示后重新 GET，再以新键提交。
- 报告导出的可用性由后端决定；未确认或 `stale` 的报告后端返回 409，前端只做提示。
- 精确分值/金额是十进制字符串，展示层只做千分位分组（`groupDecimal`），绝不 `Number()` 重算。
- 证据一律按后端给出的 `document_id/document_hash/chunk_id/page/sheet/row_*` 定位，**不按文件名关联**。

## 离线夹具

`src/demo/fixtures/**` 由真实 HTTP 接口在本地 fake 模型下导出（`scripts/export_frontend_fixtures.py`），字段与响应原样保存。合成材料只用于演示与截图验收，**不得当作真实脱敏材料验收**；已知限制见 `src/demo/fixtures/README.md`。

## 无障碍与动效

- 跳转链接、`aria-current`、`role="tablist/tab"`、状态变化用 `aria-live` 播报、抽屉 Escape 关闭并把焦点还给触发它的证据榫。
- 动效只动 `transform`/`opacity`，160–240ms；`prefers-reduced-motion: reduce` 下全部关闭（`base.css` 统一兜底）。
