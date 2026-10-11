# 离线构建说明（OFFLINE.md）

本机**完全无法访问网络**（`registry.npmjs.org` / `registry.npmmirror.com` / `mirrors.cloud.tencent.com` 全部连接失败），因此这份前端不是用 `pnpm install` 装出来的，而是复用本机已有工具链。联网后按下文"联网后如何复现"即可回到标准流程。

## 依赖来源

| 用途 | 来源 | 备注 |
| --- | --- | --- |
| react / react-dom 19.3.0、@types/react、@types/react-dom、vite 8.3.0、@vitejs/plugin-react 6.1.1、rolldown、postcss、@babel/core | 本机另一个 Vite React 项目 `C:\Users\21910\blog-app\node_modules` | 用 `.verification/node-tools/copy-toolchain.mjs` 复制进 `frontend/node_modules`（95 个包、约 53 MB） |
| typescript 5.9.3、openapi-typescript 7.10.1 | `.verification/api-client-tools/node_modules` | 用于 `tsc --noEmit` 与重新生成 `src/api/schema.ts` |

`frontend/package.json` 声明的版本与实际复制的版本一致；它是联网后 `pnpm install` 的等价声明，而不是当前安装方式的记录。

**为什么是复制而不是 `node_modules` 链接**：DSH 文件沙箱下 `fs.symlinkSync`（文件与目录两种）都返回 `EPERM: operation not permitted`，`cmd /c mklink /J` 报 `Access is denied`；`fs.cpSync(..., { dereference: true })` 正常。因此 `frontend/node_modules` 是实体副本（已展开 pnpm 的 scope 软链）。

## 必需的构建变量：`DSH_NO_NET_USE=1`

`frontend/node_modules/vite/dist/node/chunks/node.js` 的 `optimizeSafeRealPathSync()` 会执行 `exec("net use", ...)` 探测 Windows 网络驱动器。在 DSH 沙箱下该 `spawn` **直接抛 `EPERM` 而不是回调 error**（`Error: spawn EPERM` at `ChildProcess.spawn`），表现为：

```
failed to load config from ...\vite.config.ts
Build failed with 1 error: [plugin externalize-deps]
```

已就地打补丁（补丁只影响这一处探测）：

- 新增环境变量短路：`if (process.env.DSH_NO_NET_USE === "1") { safeRealpathSync = fs.realpathSync.native; return; }`
- `exec` 整体包进 `try/catch` 兜底，沙箱拒绝时退回 `fs.realpathSync.native`。

**结论：所有 `dev` / `build` / `preview` 命令都必须先 `$env:DSH_NO_NET_USE="1"`。** 该补丁在 `node_modules` 被重新安装后会丢失，需要重新应用（联网环境通常不需要，因为 `net use` 不会失败）。

## 生成的类型

```powershell
node ..\.verification\api-client-tools\node_modules\openapi-typescript\bin\cli.js `
  ..\docs\openapi.json --default-non-nullable false -o src\api\schema.ts
```

`src/api/schema.ts` 与 `docs/api-types.d.ts` 同源同尺寸（84052 B），前端只用前者。后端接口变化后必须重新生成，否则 `tsc` 报错是预期行为（这正是把契约钉在类型上的目的）。

## 文档与验收工具

- `frontend/tools/**`（Chrome DevTools Protocol 截图 / 走查 / a11y 契约检查）只依赖 Node 内置模块与 **Node 24 的全局 `WebSocket`**，不需要 playwright。
- Chrome 路径：`C:\Program Files\Google\Chrome\Application\chrome.exe`（回退 Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`）。
- 起 Chrome 时子进程 **必须** `stdio: "ignore"` 或重定向到文件：沙箱下用管道捕获子进程输出会 `EPERM`。

## 离线夹具

```powershell
# 需要 Python 3.11（.venv311）与后端依赖；脚本用 TestClient 走真实 HTTP 造数，无网络
.venv311\Scripts\python.exe scripts\export_frontend_fixtures.py
.venv311\Scripts\python.exe .verification\verify_fixtures.py      # 156 项自检
```

夹具落在 `frontend/src/demo/fixtures/`（每次重跑先整体清空再重建），临时 sqlite 在 `data/frontend-fixtures/`。

## 联网后如何复现

```powershell
cd frontend
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
pnpm install          # 或 npm install / yarn
pnpm typecheck        # tsc --noEmit
pnpm build            # 不再需要 DSH_NO_NET_USE
```

`package.json` 里的依赖版本即上文表格所列；除它们以外没有别的运行时依赖需要安装。

## 已知环境限制

- 无法安装任何新包：本机 pnpm store 只有 DSH 自己的依赖，npm 缓存里搜不到 react / vite / typescript 的可用条目。
- 无 playwright / ms-playwright；截图与走查只能用 CDP 自建工具。
- 工作区不是 git 仓库（`git status` → `fatal: not a git repository`），因此无法提供 diff 视图。
