> 清理说明：测试工具与临时验收产物已删除，下文相关命令和路径为历史记录。正常启动见项目根目录及 frontend/README.md；内置演示数据保留。前端验收工具可从 Git 提交 1629f92 恢复。

# 第五阶段：本地联调与验收

范围由用户于 2026-10-10 确认，2026-10-11 完成收尾。使用真实 React 生产构建、Chrome、HTTP API、SQLite 与 worker；模型和搜索使用合成测试服务。不会读写现有业务数据库，也不调用真实模型或搜索。

## 正常使用

仓库根目录启动 API：

```powershell
.venv311/Scripts/python.exe -m alembic upgrade head
.venv311/Scripts/python.exe -m uvicorn ai_bid_evaluator.api.app:create_app --factory --host 127.0.0.1 --port 8000
```

另开终端在仓库根目录启动 worker：

```powershell
.venv311/Scripts/python.exe -m ai_bid_evaluator.worker.main
```

另开终端启动前端：

```powershell
cd frontend
$env:DSH_NO_NET_USE='1'
node node_modules/vite/bin/vite.js
```

打开 `http://127.0.0.1:5173`。开发服务器代理 `/api` 至 8000 端口；API 与 worker 必须使用同一数据库。真实评审需要现有百炼配置，设置方式见主 README。

纯页面演示可使用 `#/projects?demo=1`；`?demo=0` 强制真实 API。健康探测必须收到 `{status:"ready"}`，静态托管返回的 HTML 不会被误判为后端就绪。`vite preview` 只用于生产静态预览，不是完整 API 部署。

## 不调用真实模型的完整联调

先构建前端，再在仓库根目录启动专用验收服务器：

```powershell
# 在 frontend 目录
$env:DSH_NO_NET_USE='1'
node node_modules/vite/bin/vite.js build
# 回仓库根目录
cd ..
.venv311/Scripts/python.exe scripts/serve_acceptance.py
```

服务器只监听 `127.0.0.1:8765`，自动创建临时数据库与 fake worker，同源提供生产前端。它是测试入口，不要用来处理真实业务材料。正常 Ctrl+C 退出后清理临时数据库。

另开终端执行：

```powershell
cd frontend
$env:DSH_NO_NET_USE='1'
node scripts/mode-regression.mjs
node scripts/submission-regression.mjs
node tools/live-acceptance.mjs
node tools/mobile-regression.mjs
node tools/walkthrough.mjs --out ../.verification/phase5/walkthrough --timeout 8000
```

`live-acceptance` 可通过 `ACCEPTANCE_URL` 指定其他本机验收地址，切勿指向业务数据库。页面矩阵工具自己启动静态服务器，不依赖 8765。Node 须具备全局 WebSocket；此次使用 Node 24。若沙箱阻止 Python SSL 或 Chrome，需在允许该进程运行的本机终端执行，不能把环境阻断记成通过。

## 验收证据

- 后端：144 项离线测试；前端 TypeScript 严格检查、生产构建及 11 路由/47 条 SSR 断言。
- 真实浏览器联调：17 项，覆盖 UI 创建项目/上传/运行/复核，两条工作流、精确分数字符串、证据定位、三种格式导出、已确认企业画像复用、响应丢失重试、幂等冲突、旧版本复核拒绝及历史报告失效保护。
- 页面矩阵：11 路由 × 1440/390 像素 × 明/暗主题，共 44 张截图；减少动效、可达名称、控制台异常等检查。11 个提示为页面初始视图没有结论徽标，不视作业务判定的验收证明。
- 浏览器记录：`.verification/phase5/live/result.json`、`walkthrough/walkthrough.json`、`walkthrough/walkthrough.md` 与 `walkthrough/shots/`；移动端回归截图在 `mobile/`。
- SSR 留痕：`frontend/.verification/ssr/`。它不能替代浏览器验证。

## 本阶段修复

1. 企业画像 ID 未进入提交体：现在携带 ID 与后端版本。
2. 网络响应丢失后重试重新读取版本：现在在提交前保存完整请求体与键，原表单重试精确重放；成功或明确 409 后清理，表单变化重新准备。
3. 演示模式白屏：函数类型的数据源必须通过 state updater 包装保存，避免被 React 当作 updater 调用。
4. HTTP 200 的 HTML 回退页误报后端就绪：现在校验健康响应内容。
5. 移动端顶栏文字竖排：调整为两行布局，保留模式与主题切换。
6. 上传页投标人输入缺少可达名称；材料留空提示错误。
7. 联调脚本跨页面保留异常，且页面创建失败或结果写入失败也会关闭浏览器；失败产物明确 `passed:false`。

独立只读复核提出的 3 项问题已处理。当前目录没有 Git，因此无提交或回滚快照；实现、测试和记录保留在工作区。

真实模型准确率、OCR、至少 10 组真实脱敏材料，以及远程身份权限不在此次合成联调的证明范围内。上游 TestClient 弃用提示与 ffmpeg 缺失警告不影响此次文本材料回归。

