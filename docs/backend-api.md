> 清理说明：测试工具与临时验收产物已删除，下文相关命令和路径为历史记录。正常启动见项目根目录及 frontend/README.md；内置演示数据保留。前端验收工具可从 Git 提交 1629f92 恢复。

# 后端 API 使用与验收

实施范围为 R01–R11；默认单机、本地访问。前端只展示后端给出的资格、分数、排名和版本，不计算业务结论。任务状态与复核保存于 SQLite，HTTP 连接断开或 API 重启不会删除任务。

## 启动

```powershell
.venv311\Scripts\python.exe -m alembic upgrade head
.venv311\Scripts\python.exe -m uvicorn ai_bid_evaluator.api.app:create_app --factory --host 127.0.0.1 --port 8000
# 在另一个终端，用相同 DATABASE_URL 启动：
.venv311\Scripts\python.exe -m ai_bid_evaluator.worker.main
```

交互文档为 `/docs`，OpenAPI 为 `/openapi.json`。API 不自动启动 worker，也不调用真实模型进行健康检查。提交业务任务后，未启动 worker 时可以查询到 `pending`。

上传文件默认最大 50 MiB，`UPLOAD_LIMIT_BYTES` 可调整。multipart 请求额外最多允许 64 KiB 的边界和字段开销；按实际读取的字节数限制，不依赖 Content-Length。解析在受控线程执行；文件路径由系统生成。相同项目、角色、投标人、格式、内容哈希的重复上传返回同一文档 ID。不同投标人的同内容材料保留各自关联。

## HTTP 接口

统一前缀 `/api/v1`，分页为 `{items, next_cursor}`。`limit` 默认 20，范围 1–100；将返回的 `next_cursor` 原样传入 `cursor`，并保留原查询条件。游标限定所属集合与筛选条件。ID 是不透明字符串，时间为带时区 ISO 8601，精确金额和评分为十进制字符串。

| 方法与路径 | 用途 |
|---|---|
| POST /projects；GET /projects | 创建项目、读取历史 |
| POST /projects/{project_id}/bidders | 创建项目内的稳定投标人 ID |
| POST /documents | multipart 上传：project_id、role、file、可选 bidder_id |
| GET /documents/{document_id}；GET /documents/{document_id}/chunks | 解析状态、质量与可分页证据块 |
| POST /runs；GET /runs | 202 提交；按 project_id/type/status 分页 |
| GET /runs/{run_id}；GET /runs/{run_id}/events | 进度与 after_seq 后的持久事件 |
| POST /runs/{run_id}/retry；POST /runs/{run_id}/cancel | 带 expected_version 的重试与取消 |
| GET /runs/{run_id}/reviews；POST /runs/{run_id}/reviews | 待复核内容、历史、确认/修改/拒绝 |
| GET /runs/{run_id}/results | 结果与逐条 evidence_matrix |
| GET /runs/{run_id}/reports | 报告版本分页 |
| GET /reports/{report_id}；GET /reports/{report_id}/export | 报告内容；json/markdown/html 下载 |
| GET /companies；GET /companies/{company_id} | 已提取并确认的企业画像及当前版本 |
| GET /health/live；GET /health/ready | 存活与就绪 |

文档角色为 `announcement / tender / bid / profile`。只有 `bid` 必须携带 bidder_id，且必须属于该项目。旧 DOC 返回 415。空文件、损坏或无法解析的材料返回明确 400；扫描/OCR不足材料以 `needs_review` 登记。企业完整档案增量更新和多租户权限不属于此批。

证据块 ID 随内容和位置固定，原始解析块和工作流分块共同保留，避免修改分块预算后覆盖旧报告的引用。前端根据 EvidenceRef.chunk_id 在分页块中定位证据；不要按文件名关联。

## 提交、轮询和复核

1. 创建项目和投标人，上传所有材料，保存返回的 ID。
2. POST /runs 带 `Idempotency-Key`。评标输入至少包含公告、招标文件和一名投标人的材料；机会输入包含画像源材料，或 `company_id + company_revision` 的已确认画像。
3. 202 返回 RunResponse 与 Location。运行中建议前台 2 秒、后台 10 秒轮询。`succeeded / failed / cancelled / awaiting_review` 时停止自动轮询。
4. `awaiting_review` 时 GET /reviews，`kind=pending` 的 `target_id / payload / revision` 给出待核对内容；`kind=history` 是审计历史。确认结果用 reason 和当时的 revision 提交复核。
5. 成功提交复核后继续轮询。修改上游会使下游结果与旧报告 stale，重新执行后产生新的报告版本。不可下载未确认或过期报告；409 时刷新最新任务/报告状态。

每个逻辑提交、复核、重试、取消请求使用独立幂等键。网络重试必须复用同一键和同一内容；同键不同内容返回 409。同键重放返回保存的原始响应，可能比当前 GET 状态旧，前端随后刷新任务。重放检查先于版本检查。版本冲突时重新 GET 最新状态，核对更改后用新键和新版本提交，不能自动覆盖。

取消先登记意图，运行中的模型请求可能先完成，在安全步骤边界转 cancelled。重试只允许 failed，保留已经完成且有效的步骤。拒绝复核将目标及下游失效；重试会重新执行并再次暂停。

资格未知、缺失证据、越界评分、错误投标人关联不能通过人工“确认”直接绕过。复核 patch 只允许目标阶段的业务字段，ID、哈希和关联不允许改写。排序与总分由程序重算。

企业画像编辑同时检查任务版本和当前企业画像版本；旧任务的画像确认/编辑不能覆盖较新的企业版本，冲突返回 409，须基于最新画像重新提交任务。人工补录文档的内容、不可变证据块和复核审计在同一事务保存；旧块及旧任务快照保留，确认后的补录材料可供后续已确认画像复用。

## 公告筛选和来源

模型资格评估之外，程序检查公告类型、截止、预算、地域。中标/成交、终止和过期公告不得推荐；截止时间等于当前时刻也排除。更正、未知类型、未知或冲突截止信息进入复核；设置预算或地域条件时，缺少相应信息也进入复核。

首版从正文显式标签提取：`投标截止时间/响应截止时间/提交投标文件截止时间/截止时间`，`预算金额/项目预算/采购预算`，`项目地区/项目地域/项目所在地`，`项目编号/采购编号`，`标段编号/标段号/包号`。金额单位元、万元、亿元统一为元；标签时间按北京时间 UTC+8。只有日期、格式歧义或多个不同值不自动推断。搜索关键词、地址片段、网页标题中的金额不当作确定性预算/地域证据。

字段标签必须完整匹配；报名、澄清、缴费等截止时间不作为投标提交截止时间。报告保留生成时的 `as_of` 与来源快照，历史报告不会因时间流逝被后台自动重写；使用历史机会报告前须结合公告截止时间核对其当前有效性。

公告历史和来源写入 notices/notice_sources。URL 规范化保留路径、业务参数大小写；已知项目编号、标段和公告类型可辅助去重，多个 provider 及原来源 URL 保留。更正记录可链接到已有招标记录，仍须核对有效公告。搜索返回空结果与来源失败分开记录；所有来源失败时任务失败，不输出“成功无机会”。单个候选抓取/评估失败保留候选并进入复核，其余候选继续。

非常规正文标签和更正公告无法直接确认推荐时，需要修正来源材料并重新运行。真实脱敏材料和 OCR 的质量验证仍是后续部署前工作。

## 错误与下载

错误统一为 `{error: {code, message, details, request_id}}`；校验 details 保留字段路径，省略输入值与原始异常。响应包含 X-Request-ID。400 为业务参数组合错误，404 为不存在，409 为状态/版本/幂等冲突，413 为上传超限，415 为格式不支持，422 为字段校验，503 为必要配置或数据库未就绪。异步步骤失败保存至 RunResponse.error。

报告保留原版本与 stale 标志；导出包含 ID、版本和原始精确数值。HTML 对所有文本转义并使用受限 CSP，Markdown 使用缩进正文避免执行源文本中的 HTML。

## OpenAPI 与离线验收

`docs/openapi.json` 是此批导出的契约，所有端点使用固定 operation_id。`docs/api-examples.json` 是合成材料产生的脱敏请求/响应示例。客户端生成与类型检查记录见 `docs/backend-validation.json`；尚未创建 React 前端。

已用 openapi-typescript 7.10.1 生成 `docs/api-types.d.ts`；`docs/api-client-example.ts` 展示基于生成类型的上传、提交、轮询、复核和错误处理，使用 TypeScript 5.9.3 strict 编译验证。生成工具仅安装于项目临时验证目录；正式 React 项目开始时再锁定其工具链。

```powershell
.venv311\Scripts\python.exe scripts/export_api_artifacts.py
node .verification/api-client-tools/node_modules/openapi-typescript/bin/cli.js docs/openapi.json --default-non-nullable false -o docs/api-types.d.ts
node .verification/api-client-tools/node_modules/typescript/bin/tsc --noEmit --strict --lib ES2022,DOM docs/api-types.d.ts docs/api-client-example.ts
.venv-batch-validation\Scripts\python.exe scripts/smoke_backend.py
```

```powershell
.venv311\Scripts\python.exe -m pytest tests/unit tests/integration tests/api -q
.venv311\Scripts\python.exe -m pytest -q
.venv311\Scripts\python.exe -m pip check
```

两条 API 链均使用 fake 模型、搜索和公告；测试覆盖非法 JSON、两投标人重排、复核上下界、空资格、源失败、重启恢复、幂等、取消和报告失效。CLI/API 同输入的资格、精确分数、排名、复核点一致。API/worker 仍通过同一应用服务与数据库协作。

模拟链验证不能替代真实模型、OCR或商业结论准确率。真实脱敏材料至少 10 组是后续质量基线，当前未获得这批材料；不可把合成示例称为真实材料验收。

