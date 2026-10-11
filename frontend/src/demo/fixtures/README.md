> 清理说明：测试工具与临时验收产物已删除，下文相关命令和路径为历史记录。正常启动见项目根目录及 frontend/README.md；内置演示数据保留。前端验收工具可从 Git 提交 1629f92 恢复。

# 前端离线演示夹具（fixtures）

## 这是谁生成的
本目录全部内容由脚本 `scripts/export_frontend_fixtures.py` 生成，命令：

```powershell
.venv311\Scripts\python.exe scripts/export_frontend_fixtures.py
```

脚本通过 `TestClient` 调用**真实后端 HTTP 接口**造数，模型与搜索使用
`tests/workflow_fakes.py` 中的离线 fake 实现，**全程无网络、无 API Key**。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `index.json` | 总索引：`projects` / `bidders` / `documents` / `runs` / `reports` / `companies`，另有 `gaps` 与 `statistics` |
| `runs/<run_id>.json` | 单个任务的全量数据：`run`、`events`、`results`、`reviews`、`reports`、`report_details` |
| `documents/<document_id>.json` | 单个材料：`document`（GET 响应原样）与 `chunks` 列表 |

所有响应均为**后端原样 JSON**：字段不裁剪、不归一化，数值保持十进制字符串
（如 `"8.5"`、`"6.25"`、`"86.75"`），时间为带时区 ISO 8601。

## 哪些是合成数据
**全部都是合成数据。** 项目名、投标人、材料正文、公告与企业画像均为演示用假数据，
由 `tests/workflow_fakes.py` 的常量文本生成；其中的评分、结论、证据引用都是
离线 fake 模型的固定输出，不对应任何真实招标项目或真实企业。

演示覆盖的真实状态：

1. `bid_evaluation`：公告 + 招标文件 + 2 家投标人（`tests/workflow_fakes.BID_TEXTS`
   只提供 2 份合成投标材料，脚本按数量对齐投标人，`BID0` 得 `"8.5"`、`BID1` 得 `"6.25"`），
   包含一次 `awaiting_review` 复核（抽取规则首次返回非法 JSON，重试后仍需人工确认）、
   一次"改分 / 重排"编辑复核，因此保留 **一个历史 stale 报告 + 一个最新报告**。
2. `opportunity_discovery`：企业画像 → 人工确认 → 公司画像落库 → 检索 → 结果 → 报告。

## `gaps` 的含义
`index.json` 的 `gaps` 是数组，记录**脚本无法从真实接口取得或未达预期的字段/状态**
（例如 events 为空、某文档状态不是 `ready`、某条链路未跑到 `succeeded`）。
出现 `gaps` 条目不表示夹具被伪造——脚本只做如实记录，**不会补假数据**。
若 `gaps` 非空，请把该条目当作已知限制读，而不是当作可展示的真实数据。

## 使用红线
**不得把本目录的合成示例当作真实材料验收结论。** 这些夹具仅用于前端离线演示、
组件联调与截图验收；任何面向真实招投标材料的验收、评分、结论都必须来自
真实后端对真实（脱敏）材料的处理结果。

## 幂等与重跑
脚本每次运行会先清空本目录再重建；`Idempotency-Key` 使用固定字符串，
除 `generated_at` 与随机生成的 id 外产物内容稳定。重跑不会触碰
`data/backend.db` 或仓库中其它已有数据库。

