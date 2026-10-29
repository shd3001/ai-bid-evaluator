# AI 招投标辅助评审后端

已实现 FastAPI 修复方案 R01–R11：严格数据契约、三态资格、确定性评分/排名、文档证据、SQLite 持久化、人工复核、独立 worker 和业务 API。

**两条业务链均可经 API 上传、提交、复核并读取结果与报告。** 项目历史、持久进度、证据块、企业画像及报告导出已提供；CLI 保持兼容。React 评审台已实现，并完成第五阶段本地联调。见 [前端说明](frontend/README.md)、[第五阶段验收与启动指南](docs/phase-5-acceptance.md)及[后端 API 文档](docs/backend-api.md)。

## 安装

验证基线：Windows、Python 3.11；`requirements-lock.txt` 锁定直接及传递依赖。现有 `.venv311` 已安装并通过测试。新环境：

```powershell
py -3.11 -m venv .venv311
.venv311\Scripts\python.exe -m pip install -r requirements.txt
```

测试文件、前端验收工具及临时产物已按要求移除。历史验收结果保留在文档中；清理前的前端验收工具可从 Git 提交 `1629f92` 恢复，该提交不包含更早已删除的 `tests/` 目录。运行依赖、真实业务数据与前端内置演示数据保留。

## 启动 API 与 worker

```powershell
.venv311\Scripts\python.exe -m alembic upgrade head
.venv311\Scripts\python.exe -m uvicorn ai_bid_evaluator.api.app:create_app --factory --host 127.0.0.1 --port 8000
# 另一个终端：
.venv311\Scripts\python.exe -m ai_bid_evaluator.worker.main
```

- `GET /api/v1/health/live`、`GET /api/v1/health/ready`，交互文档 `/docs`、Schema `/openapi.json`。
- API 启动/健康检查/OpenAPI 导出不调用模型、不启动 worker；无密钥可以检查接口。
- worker 从 SQLite 原子领取任务；默认租约 120 秒，每 30 秒续租。人工检查点释放租约，其他任务可继续。
- 任务在 SQLite 提交后才执行。worker 未运行时 `pending` 记录不会丢失。
- `--once` 执行一个可运行任务后退出；`--database sqlite:///...` 可指定数据库。
- API 与 worker 必须使用同一 `DATABASE_URL`；`data/backend.db` 是默认本机库。多机共享 SQLite 不在首版范围。

## 日志与停机

- 默认每条日志一行 JSON 输出到 stdout（`journalctl -o cat` 或日志采集可直接解析）：`ts/level/service/logger/msg` 加业务字段。`service` 区分 `api` 与 `worker`。
- 每个请求带 `request_id`：可用 `X-Request-ID` 传入（仅 `[A-Za-z0-9_-]`、≤100 字符），否则生成，并回写到响应头；同一请求内的错误日志带相同 ID。worker 的日志带 `run_id`。
- 未处理异常记 `unhandled_error` 并保留完整堆栈；4xx 只记 `code`/`status`/字段名。不打印请求体、提示词、密钥或正文。`httpx` 默认只记告警，排查上游问题时设 `LOG_HTTPX_LEVEL=INFO`。
- 环境变量：`LOG_LEVEL`（默认 `INFO`）、`LOG_FORMAT`（`json` 默认，`text` 便于本机终端）、`LOG_UVICORN_ACCESS_LEVEL`（默认 `WARNING`，访问日志已由请求中间件输出，避免重复）。
- worker 收到 `SIGTERM`/`SIGINT`/`SIGBREAK` 后先取消执行中的任务：不写失败、不写检查点，保留租约，由下一个 worker 在租约到期后续跑；随后关闭模型客户端和数据库再退出。`--once` 不受影响。
- Windows 控制台请用 `CTRL_BREAK` 停机（`CTRL_C` 对新进程组默认禁用，直接关窗口是强制终止）；Linux 用 `kill`/`SIGTERM`。
- 改动日志或停机逻辑后运行自检：`.\.venv311\Scripts\python.exe scripts\verify_observability.py`（8 项，含真实子进程停机验证）。

## Docker 部署（单机）

仓库自带 `Dockerfile`（多阶段：前端构建 → 后端运行时 → nginx 静态站点）、`docker-compose.yml`、`deploy/nginx.conf` 和 `.env.docker.example`。拓扑是 `web(nginx) → api`，`worker` 独立进程，`migrate` 一次性建表；SQLite 与运行产物都在 `bid-data` 卷的 `/app/data` 下。

**前置**：Windows 上装好 Docker Desktop 并启用 WSL2 后端，确认 `docker version` 能打印 Server 段。只有客户端、daemon 没起来时会报 `failed to connect ... npipe:////./pipe/dockerDesktopLinuxEngine`。

```powershell
# 1) 配置环境变量（已有 .env 可跳过，compose 会自动读取；.env 已被 .dockerignore 排除，不进镜像）
Copy-Item .env.docker.example .env
# 编辑 .env 填 DASHSCOPE_API_KEY / SEARCH_API_KEY

# 2) 构建镜像（首次要拉基础镜像并装依赖，几分钟）
docker compose build

# 3) 启动：migrate 建表成功后才起 api/worker，api 通过健康检查后才起 web
docker compose up -d
docker compose ps
```

- 前端入口 `http://localhost:8080`；API 文档 `http://localhost:8080/docs`；反代探活 `http://localhost:8080/healthz`。
- `api` 额外把 `127.0.0.1:8000` 映射到宿主机，只供本机排查，不要对外暴露。
- 首次启动 `bid-data` 是空卷：只建表，不会自动带入本机 `data/` 里的开发数据；要带旧数据就把本机 `data/` 拷进卷。
- 容器内直连 `pypi.org` 常常超时（表现为 `Connection to pypi.org timed out` 后 `No matching distribution found`）；`Dockerfile` 已默认用阿里云 pip 镜像，能直连 pypi 的环境可覆盖：`docker compose build --build-arg PIP_INDEX_URL=https://pypi.org/simple`。
- PowerShell 里 docker 把构建进度写到 stderr，`docker compose up` 可能看起来 `exit code: 1`；以 `docker compose ps` 的状态和 `/healthz` 为准。
- 日志：`docker compose logs -f api worker`（JSON 一行一条；本地调试可临时设 `LOG_FORMAT=text`）。
- 停机：`docker compose down`。worker 收 `SIGTERM` 会取消在跑任务、保留租约再退出（`stop_grace_period: 90s`），下次启动续跑。
- 升级：改完代码 `docker compose build && docker compose up -d`；数据在卷里，不受影响。
- 备份（PowerShell，先算好卷名，默认带项目前缀）：

```powershell
docker run --rm -v ai-bid-evaluator_bid-data:/data -v ${PWD}:/backup alpine `
  tar czf /backup/bid-data-$(Get-Date -Format yyyyMMdd-HHmmss).tgz -C /data .
```

**约束与注意**

- 只支持单机 SQLite：不要对 `api`/`worker` 做 `--scale`，也不要挂 NFS/多机共享 `data`；需要多机时先改 PostgreSQL。
- `api` 没有身份认证，`8080` 仅限内网；要公网访问必须前置 HTTPS 反向代理（Caddy/Nginx）并自行补认证。
- 上传上限：后端 50MiB、nginx 64m；`proxy_read_timeout 300s` 覆盖大文档解析与模型等待。
- 模型与搜索 API 按量计费：只要提交真实任务就会产生调用，`BAILIAN_RETRY_COUNT` 的重试同样计费。

## 两个兼容 CLI 入口

原有 JSON 输入文件仍可使用；解析使用本地统一摄取，不再依赖百炼文件上传成功。文档 ID 和 bidder_id 由服务生成，显示名称不用于路径和结果关联。

```powershell
.venv311\Scripts\python.exe -m ai_bid_evaluator.main --input data/bid_eval_input.json
.venv311\Scripts\python.exe -m ai_bid_evaluator.search_opportunity_main --input data/opportunity_input.json
# 仅提交，交给独立 worker；同键同材料重放返回同一 run_id：
.venv311\Scripts\python.exe -m ai_bid_evaluator.main --input data/bid_eval_input.json --submit-only --idempotency-key evaluation-001
# 使用上一步显示的真实 run_id 继续：
.venv311\Scripts\python.exe -m ai_bid_evaluator.main --run-id run_xxx
```

机会输入首版只接受一家企业材料，多份不同企业材料会明确报错。

每个任务的步骤产物位于 `data/runs/<run_id>/`。到达 `awaiting_review` 后，在该目录检查步骤 JSON，填写 `review_request.json` 的理由和版本；确认使用 `decision=confirm`，修改使用 `decision=edit` 和 `patch`，拒绝使用 `decision=reject`。CLI 负责终端交互，worker 内没有 `input()`。`AUTO_YES=1` 只保存检查点，不自动确认资格、规则或推荐。

应用代码可直接使用 `RunService.create/retry/cancel`、`ReviewService.apply` 和 `RunRepository.load/steps/reviews/events`。创建、复核、取消、重试均保存幂等响应，重放检查先于版本检查。

上游修改会保留历史复核/报告、将下游标为 stale，重新执行下游；报告完成后清除当前结果 stale。失败任务只重试未完成步骤。运行中的取消请求在安全步骤边界生效，已经产生的结果保留。强制终止 worker 后，过期租约恢复未完成步骤；外部模型请求在临界崩溃时可能重复，数据库结果保持幂等。

复核拒绝会使目标步骤及下游失效；重试会重新执行该步骤并再次等待复核。相同输入可能复用经过 Schema 校验的模型缓存；要纠正内容，使用带理由和证据的 `edit`，或修改源材料创建新任务。

## 文档与证据

已验证解析器：文本/Markdown/JSON、HTML、CSV、DOCX、XLSX/XLSM、文本 PDF。PDF 保留页码与表格行列；Excel 保留工作表和单元格范围；DOCX 保留块/表格定位，不虚构排版页码。分块使用保守 UTF-8 字节预算，逐块处理，不静默截断。

- 扫描页没有配置 OCR 时明确 `needs_review`。OCR 可通过 `ingest_document(..., ocr=backend)` 注入，返回正文和 0–1 置信度；低质量或异常有结构化诊断。当前没有安装 OCR 引擎，真实中文扫描质量尚未验证。
- 空文档、损坏文件、旧 `.doc`、未知格式不会作为成功正文进入模型；旧 DOC 须先转换。
- Excel 公式不冒充已算出的金额，进入复核。
- `EvidenceRef` 必须匹配文档哈希、文本块、定位和原文摘录；不能引用其他投标人的材料。
- 当前测试样本为脱敏/合成样本；真实材料的模型准确率、中文 OCR 和复杂跨页表格仍需专项质量验收。

## 模型配置与规则

保留百炼兼容适配，执行真实模型任务才需要 `DASHSCOPE_API_KEY`。没有自动迁移服务商、创建密钥或调用真实模型。模型客户端按生命周期复用/关闭，SDK 重试关闭，由应用统一做有界重试；认证错误不重试。缓存键包含模型、提示词、Schema 和全部输入，缓存及调用元数据持久化；日志事件不含密钥/全量正文。

资格为 `passed / failed / needs_review`；缺信息不默认为通过或失败。资格不通过可显示参考分，但不得推荐。评分检查规则 ID、缺项/重复项、满分树、数值有限性及上下界；价格只允许固定操作类型且参数完整。排名和报告事实由程序生成，模型不能改写 ID、分值、资格和推荐。

- `price_ratio` 的共同规则只提供 `parameters.base_price`；每个投标人的 `ScoreItem.inputs.bid_price` 必须有对应报价证据。缺报价或证据进入复核，不能使用共同规则中的 `bid_price`。
- 同一评分项在多个文本块出现时，保留全部 `score_alternatives`，要求人工按确认规则汇总并补全最终评分项；不会把相同分数直接去重，也不会盲目相加。仅点击确认不能跳过缺项。
- 企业画像每条 `qualifications` 保留资质原文，并须在本企业材料的证据摘录中出现。人工编辑和复用已确认画像均校验文档、哈希、块和定位；无证据的资格主张不能确认。
- 机会推荐须包含各资格规则的 `checks`，并引用企业材料证明满足。仅引用公告要求不能证明企业具备资格。

机会评估为企业画像摘要粗筛。程序额外检查公告类型、截止时间和设置的预算/地域条件；中标、终止、过期不得推荐，更正或未知信息进入复核。多来源、公告版本及源失败诊断保留。首版只从显式正文标签提取时效与金额，非常规格式须核对来源并重新运行；模型和真实材料准确率尚未验收。

可配置项：`DATABASE_URL`、`CORS_ORIGINS`、`MODEL_TIMEOUT_SECONDS`、`WORKER_LEASE_SECONDS`、`WORKER_HEARTBEAT_SECONDS`、`CHUNK_MAX_TOKENS`、`WORKER_POLL_SECONDS`、`UPLOAD_LIMIT_BYTES`（默认 50 MiB）；原有 `BAILIAN_*`、搜索配置保留。默认本机绑定与明确开发 origin；多人远程访问和身份权限未纳入此次范围。

## 旧结果导入

在目标数据库先登记项目，再运行：

```powershell
.venv311\Scripts\python.exe -m ai_bid_evaluator.infrastructure.import_legacy data/old_report.json --project-id project_xxx
```

导入保留原文件，标记为待核对/过期归档，不把旧 JSON 视为当前有效报告。产生有效结论需要使用源材料重新创建任务。

实施记录见 [第一、第二批进度](docs/superpowers/plans/2026-10-03-batches-1-2-progress.md) 与 [第三批进度](docs/superpowers/plans/2026-10-03-batch-3-progress.md)。
