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

测试脚本、浏览器验收工具与临时截图已移除。历史设计见 [DESIGN.md](docs/DESIGN.md)，本机依赖说明见 [OFFLINE.md](docs/OFFLINE.md)。
