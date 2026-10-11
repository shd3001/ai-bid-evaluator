/**
 * 主题（浅色 / 深色 / 跟随系统）。
 *
 * 设计契约在 `frontend/docs/DESIGN.md` 里给了完整的 `[data-theme="dark"]` 令牌，
 * 但令牌本身不会生效——必须有人在 `<html>` 上写 `data-theme`。
 * 这里就是那个"有人"，另外负责在首屏渲染前把主题定下来，避免闪一下白底。
 *
 * 选择存 localStorage：这是纯展示偏好，不是业务事实，不进后端也不进 URL。
 */
export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "review-desk.theme.v1";
const DARK = "(prefers-color-scheme: dark)";

export function readThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // 隐私模式/被禁用的 localStorage：当成跟随系统，不影响功能。
  }
  return "system";
}

function prefersDark(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(DARK).matches;
  } catch {
    return false;
  }
}

/** 把选择解析成真正生效的主题，并写到 `<html data-theme>` 上。 */
export function applyTheme(choice: ThemeChoice = readThemeChoice()): "light" | "dark" {
  const resolved: "light" | "dark" = choice === "system" ? (prefersDark() ? "dark" : "light") : choice;
  const root = document.documentElement;
  root.setAttribute("data-theme", resolved);
  // 顺带告诉浏览器表单控件/滚动条该用哪套配色
  root.style.colorScheme = resolved;
  return resolved;
}

/** 在 React 挂载之前调用，避免先亮后暗的闪烁。 */
export function initTheme(): void {
  applyTheme();
}

export function setThemeChoice(choice: ThemeChoice): "light" | "dark" {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // 存不下也无所谓：本次会话仍然生效。
  }
  return applyTheme(choice);
}

/** 三态循环：跟随系统 → 浅色 → 深色 → 跟随系统。 */
export function nextThemeChoice(current: ThemeChoice): ThemeChoice {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};
