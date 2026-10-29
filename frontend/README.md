# 评审台前端

React + TypeScript + Vite。前端负责展示和提交；资格、分值、排名、报告版本与失效状态均由后端决定。

## 开发与构建

在本目录执行（需要 Node，当前本机依赖已保留）：

```powershell
$env:DSH_NO_NET_USE='1'
node node_modules/vite/bin/vite.js
```

打开 http://127.0.0.1:5173 。开发服务器将 /api 代理到 127.0.0.1:8000；后端和 worker 启动方法见[项目说明](../README.md)。

```powershell
# 类型检查
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# 生产构建
node node_modules/vite/bin/vite.js build
```

`dist/` 是生产静态产物。正式托管时需另行提供同源 /api 转发；静态预览本身不启动后端。

## 运行模式

- 默认探测后端健康状态，不可达则进入只读演示。
- `#/projects?demo=1` 强制演示；`?demo=0` 强制使用真实 API。
- `src/demo/fixtures/` 是构建需要的内置演示数据，须保留。它是合成材料，不代表真实业务质量验证。
- 明暗主题支持跟随系统及本机保存。

历史验收工具曾被移除；本次保留了项目主流程的针对性回归测试。历史设计见 [DESIGN.md](docs/DESIGN.md)，本机依赖说明见 [OFFLINE.md](docs/OFFLINE.md)。

## 项目主流程

创建项目成功后直接进入该项目的「交材料」，失败保留输入。项目列表的「进入项目」遍历运行分页，按创建时间选择最新评标运行：无运行进入上传，待复核进入复核，成功且有有效报告进入最新有效报告，其余进入运行进度。查询失败留在当前页重试。

顶部导航和面包屑使用服务器返回的运行状态；回看材料会保留运行上下文，不将访问页面视作完成业务。未解锁的复核、报告深链接返回当前可操作阶段。运行创建页保持独立的新任务上下文，不继承旧任务的报告状态。已完成步骤可回看；人工复核后仍可能回到运行阶段继续执行。

没有运行的项目仍使用本机上传回执和手动文档 ID；未增加后端材料或投标人列表接口。项目名称只做展示缓存，刷新后可从分页项目列表重新读取。报告 ID 查询参数用于定位有效版本，不改变后端导出校验。

## 流程回归

在 frontend 目录使用 Node 24 执行：

```powershell
node --experimental-strip-types --test tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/vite/bin/vite.js build
node tests/browser-flow.mjs
```

浏览器回归使用本机 Chrome/Edge（可通过 `CHROME_PATH` 指定），自动启动独立本机服务器、模拟 API 和临时浏览器配置，不连接业务后端或模型。截图与结果保存在 `.verification/project-flow/`，失败返回非零退出码。等价 npm 命令为 `npm test` 和构建后的 `npm run test:browser`。
