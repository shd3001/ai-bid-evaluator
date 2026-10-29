# 单机 Docker 部署：一个 Python 镜像承载两种入口（API / worker），另加一个 nginx 静态站点镜像。
#
# 关键点：SQLite 库与运行产物必须落在 /app/data 卷上。项目以 editable 方式安装，
# 这样 config.project_root 才会解析成 /app；若用普通安装，它会解析到 site-packages 附近，
# data/ 与 .env 的位置都会错，运行产物也不会进卷。

# ---------- 前端构建 ----------
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 后端运行时 ----------
FROM python:3.11-slim AS api
# 容器内直连 pypi.org 常超时（15s connect timeout 反复重试后报 "No matching distribution"），
# 默认改用阿里云镜像；在能直连 pypi 的环境里可以覆盖：
#   docker compose build --build-arg PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# 先装锁定依赖，代码改动不会让这一层缓存失效。
COPY requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements-lock.txt

COPY pyproject.toml ./
COPY src ./src
# 非 editable 会把 project_root 指到 site-packages，必须 editable。
# 构建依赖已在锁定文件里（setuptools>=78 + wheel），关掉隔离避免再联网拉一套。
RUN pip install --no-cache-dir --no-deps --no-build-isolation -e .

COPY alembic.ini ./

RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "ai_bid_evaluator.api.app:create_app", \
     "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]

# ---------- 静态站点 ----------
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /frontend/dist /usr/share/nginx/html
EXPOSE 80