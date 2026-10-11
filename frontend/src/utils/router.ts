/**
 * 零依赖 hash 路由。
 * 用 hash 而不是 history API：静态产线预览（vite preview / file 协议）刷新不会 404，
 * 也不需要服务器回退规则。页面路线集中登记在 ROUTES 里。
 */
import { useEffect, useState } from "react";

export interface Route {
  name: string;
  pattern: string;
  title: string;
  /** 阶段带上的步骤号：1 建项目 / 2 交材料 / 3 看进度 / 4 复核 / 5 报告。 */
  phase?: 1 | 2 | 3 | 4 | 5;
}

export const ROUTES: Route[] = [
  { name: "projects", pattern: "/projects", title: "项目台", phase: 1 },
  { name: "project", pattern: "/projects/:projectId", title: "项目详情", phase: 1 },
  { name: "upload", pattern: "/projects/:projectId/upload", title: "交材料", phase: 2 },
  { name: "documents", pattern: "/documents/:documentId", title: "材料解析" },
  { name: "runNew", pattern: "/runs/new", title: "发起评审", phase: 3 },
  { name: "run", pattern: "/runs/:runId", title: "评审进度", phase: 3 },
  { name: "review", pattern: "/runs/:runId/review", title: "人工复核", phase: 4 },
  { name: "report", pattern: "/runs/:runId/report", title: "评审报告", phase: 5 },
  { name: "opportunity", pattern: "/opportunity", title: "机会筛选", phase: 1 },
  { name: "about", pattern: "/about", title: "关于与离线说明" },
  { name: "notFound", pattern: "/:rest*", title: "页面不存在" },
];

export interface RouteMatch {
  path: string;
  name: string;
  title: string;
  phase?: 1 | 2 | 3 | 4 | 5;
  params: Record<string, string>;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1).replace(/\*$/, ""));
        return segment.endsWith("*") ? "(.*)" : "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^/${source}/?$`), keys };
}

const COMPILED = ROUTES.map((route) => ({ route, ...compile(route.pattern) }));

/** 把 `#/runs/x?demo=1` 规范成 `{ path: "/runs/x", query: "demo=1" }`。 */
export function readLocation(): { path: string; query: string } {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { path: "/projects", query: "" };
  const [path, query = ""] = raw.split("?");
  return { path: path || "/projects", query };
}

export function match(path: string): RouteMatch {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  for (const entry of COMPILED) {
    const found = entry.regex.exec(normalized);
    if (!found) continue;
    const params: Record<string, string> = {};
    entry.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(found[index + 1] ?? "");
    });
    return { path: normalized, name: entry.route.name, title: entry.route.title, phase: entry.route.phase, params };
  }
  return { path: normalized, name: "notFound", title: "页面不存在", params: {} };
}

export function navigate(path: string, options: { replace?: boolean; keepQuery?: boolean } = {}): void {
  const { query } = readLocation();
  const suffix = options.keepQuery && query ? `?${query}` : "";
  const target = `#${path}${suffix}`;
  if (window.location.hash === target) return;
  if (options.replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

/** 生成带 query 的链接：href("/runs/x", { demo: "1" }) */
export function href(path: string, query?: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString();
  return `#${path}${suffix ? `?${suffix}` : ""}`;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useRoute(): RouteMatch {
  const [route, setRoute] = useState<RouteMatch>(() => match(readLocation().path));
  useEffect(() => {
    const update = () => setRoute(match(readLocation().path));
    update();
    return subscribe(update);
  }, []);
  useEffect(() => {
    document.title = `${route.title} · 评审台`;
  }, [route.title]);
  return route;
}

export function useQuery(): URLSearchParams {
  const [query, setQuery] = useState(() => new URLSearchParams(readLocation().query));
  useEffect(() => {
    const update = () => setQuery(new URLSearchParams(readLocation().query));
    update();
    return subscribe(update);
  }, []);
  return query;
}

/** 更新当前地址上的查询参数（不动路径），用于分页游标、筛选、demo 开关。 */
export function setQuery(patch: Record<string, string | null | undefined>, options: { replace?: boolean } = {}): void {
  const { path, query } = readLocation();
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }
  navigate(`${path}${params.toString() ? `?${params.toString()}` : ""}`, { replace: options.replace ?? false });
}
