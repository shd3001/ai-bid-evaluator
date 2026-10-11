/**
 * frontend/tools/lib/checks.mjs
 * 浏览器端审计脚本（字符串形式，用 Runtime.evaluate 注入）与 Node 端判定逻辑。
 * 被 a11y-contract.mjs 与 walkthrough.mjs 共用，避免两处断言漂移。
 *
 * 设计契约来源：frontend/docs/DESIGN.md（令牌/主题/排版）与本仓库走查要求：
 *   ① [data-verdict] 只能是 passed/failed/needs_review/pending
 *   ② 分值/金额节点应命中 .ledger-num
 *   ③ 无证据结论应出现 .tenon--missing
 *   ④ prefers-reduced-motion: reduce 下不得有正在运行的 transform 动画
 */

/** 结论徽标的四个合法取值 */
export const VERDICT_VALUES = ["passed", "failed", "needs_review", "pending"];

/** 关键选择器（与 DESIGN.md 约定一致） */
export const SELECTORS = {
  root: "#root",
  errorBoundary: "#app-error",
  verdict: "[data-verdict]",
  ledgerNum: ".ledger-num",
  mono: ".mono",
  tenonMissing: ".tenon--missing",
};

/** 桩页面/未实现页面的特征文案 */
export const PLACEHOLDER_PATTERNS = ["正在初始化", "评审台正在初始化", "initializing", "loading…"];

/**
 * 完整审计表达式（在页面里求值，返回可 JSON 化的对象）。
 * 注意：必须自包含，不能引用 Node 侧变量。
 */
export const AUDIT_EXPRESSION = `(() => {
  const VERDICTS = ["passed", "failed", "needs_review", "pending"];
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => ((el && el.textContent) || "").replace(/\\s+/g, " ").trim();
  const clip = (s, n) => (s || "").slice(0, n);

  const isDisplayed = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.hasAttribute("hidden")) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return { name: aria.trim(), source: "aria-label" };
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\\s+/).map((id) => txt(document.getElementById(id))).filter(Boolean).join(" ");
      if (t) return { name: t, source: "aria-labelledby" };
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return { name: title.trim(), source: "title" };
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(txt).filter(Boolean).join(" ");
      if (t) return { name: t, source: "label" };
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && /^(submit|button|reset)$/i.test(el.getAttribute("type") || "")) {
      const v = (el.getAttribute("value") || "").trim();
      if (v) return { name: v, source: "value" };
    }
    const t = txt(el);
    if (t) return { name: t, source: "text" };
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img) {
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt) return { name: alt, source: "img[alt]" };
    }
    return { name: "", source: null };
  };

  // ---- 交互元素可达性 ----
  const interactiveSel = "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch]";
  const interactive = { total: 0, unreachable: [], hiddenSkipped: 0, disabled: 0 };
  for (const el of qa(interactiveSel)) {
    if (!isDisplayed(el)) { interactive.hiddenSkipped++; continue; }
    interactive.total++;
    if (el.disabled) interactive.disabled++;
    const { name, source } = accessibleName(el);
    if (!name) {
      const r = el.getBoundingClientRect();
      interactive.unreachable.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        role: el.getAttribute("role") || null,
        text: clip(txt(el), 60),
        ariaHidden: el.getAttribute("aria-hidden"),
        disabled: !!el.disabled,
        box: [Math.round(r.width), Math.round(r.height)],
        selectorHint: el.id ? "#" + el.id : el.className && typeof el.className === "string" ? el.tagName.toLowerCase() + "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : el.tagName.toLowerCase(),
        nameSource: source,
      });
    }
  }

  // ---- 样式表规则统计 ----
  const styles = { sheets: 0, totalRules: 0, focusVisible: 0, outlineNone: 0, reducedMotionMedia: 0, focusVisibleSelectors: [], readErrors: [] };
  const seenReduced = new Set();
  const scanRules = (rules) => {
    for (const rule of rules || []) {
      styles.totalRules++;
      if (rule.selectorText && rule.selectorText.includes(":focus-visible")) {
        styles.focusVisible++;
        if (styles.focusVisibleSelectors.length < 8) styles.focusVisibleSelectors.push(clip(rule.selectorText, 90));
      }
      const st = rule.style;
      if (st && (st.outline === "none" || st.outline === "0" || st.outlineWidth === "0px" || (st.outlineStyle === "none" && st.outlineWidth !== ""))) {
        styles.outlineNone++;
      }
      const isReduced = (rule.conditionText && /prefers-reduced-motion\\s*:\\s*reduce/.test(rule.conditionText)) ||
                        (rule.media && rule.media.mediaText && /prefers-reduced-motion\\s*:\\s*reduce/.test(rule.media.mediaText));
      if (isReduced) {
        const key = (rule.conditionText || (rule.media && rule.media.mediaText) || "") + "::" + styles.totalRules;
        if (!seenReduced.has(key)) { seenReduced.add(key); styles.reducedMotionMedia++; }
      }
      if (rule.cssRules && rule.cssRules.length) scanRules(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    styles.sheets++;
    let rules = null;
    try { rules = sheet.cssRules; } catch (e) { styles.readErrors.push({ href: sheet.href || "(inline)", error: String((e && e.message) || e) }); continue; }
    scanRules(rules);
  }

  // ---- 图片 / 语言 ----
  const images = { total: 0, missingAlt: [], emptyAlt: 0 };
  for (const img of qa("img")) {
    images.total++;
    if (!img.hasAttribute("alt")) images.missingAlt.push({ src: clip(img.getAttribute("src") || "", 80), cls: clip(String(img.className || ""), 40) });
    else if ((img.getAttribute("alt") || "").trim() === "") images.emptyAlt++;
  }

  // ---- 运行中的动画（reduced-motion 断言用）----
  const animations = (() => {
    try {
      if (!document.getAnimations) return { supported: false, total: 0, running: 0, runningTransform: 0, names: [] };
      const list = document.getAnimations({ subtree: true });
      const running = list.filter((a) => a.playState === "running");
      const transformish = running.filter((a) => {
        try {
          const frames = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
          return frames.some((f) => f.transform !== undefined && f.transform !== "" && f.transform !== "none");
        } catch (e) { return false; }
      });
      return {
        supported: true,
        total: list.length,
        running: running.length,
        runningTransform: transformish.length,
        names: Array.from(new Set(transformish.map((a) => String(a.animationName || a.id || a.transitionProperty || "?")))).slice(0, 10),
      };
    } catch (e) {
      return { supported: false, error: String((e && e.message) || e), total: 0, running: 0, runningTransform: 0, names: [] };
    }
  })();

  // ---- 设计契约 ----
  const verdictNodes = qa("[data-verdict]");
  const verdictCounts = {};
  const verdictValues = [];
  for (const el of verdictNodes) {
    const v = (el.getAttribute("data-verdict") || "").trim();
    verdictValues.push(v);
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
  }
  const ledgerNodes = qa(".ledger-num");
  const monoNodes = qa(".mono");
  const tenonMissing = qa(".tenon--missing");
  const numericLike = [];
  if (ledgerNodes.length === 0) {
    const cand = qa("td, dd, span, div, strong, b, p");
    for (const el of cand) {
      if (el.children.length) continue;
      if (el.closest(".ledger-num, .mono, script, style")) continue;
      const s = (el.textContent || "").trim();
      if (!s || s.length > 24) continue;
      const isNumberish = /^[-+]?\\d[\\d,]*(?:\\.\\d+)?%?$/.test(s) || /^[¥￥$]\\s?\\d[\\d,]*(?:\\.\\d+)?$/.test(s) || /^\\d[\\d,]*(?:\\.\\d+)?\\s*(?:元|万元|分|%|次|天)$/.test(s);
      if (isNumberish) numericLike.push({ tag: el.tagName.toLowerCase(), text: clip(s, 24) });
      if (numericLike.length >= 20) break;
    }
  }

  const rootEl = q("#root");
  const eb = q("#app-error");
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    lang: document.documentElement.getAttribute("lang"),
    charset: document.characterSet,
    root: { exists: !!rootEl, children: rootEl ? rootEl.children.length : 0, text: clip(txt(rootEl), 200), textLength: txt(rootEl).length },
    errorBoundary: { present: !!eb, text: clip(txt(eb), 300) },
    h1: clip(txt(q("h1")), 90),
    h1Count: qa("h1").length,
    bodyTextLength: ((document.body && document.body.innerText) || "").trim().length,
    bodyTextSample: clip(((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim(), 200),
    interactive,
    styles,
    images,
    animations,
    contract: {
      verdicts: { total: verdictNodes.length, counts: verdictCounts, values: verdictValues.slice(0, 40), invalid: verdictValues.filter((v) => VERDICTS.indexOf(v) === -1) },
      ledgerNum: { count: ledgerNodes.length, sample: ledgerNodes.slice(0, 5).map((e) => clip(txt(e), 24)) },
      mono: { count: monoNodes.length, sample: monoNodes.slice(0, 5).map((e) => clip(txt(e), 24)) },
      tenonMissing: { count: tenonMissing.length, sample: tenonMissing.slice(0, 5).map((e) => clip(txt(e), 40)) },
      numericLikeWithoutLedgerClass: numericLike,
    },
  };
})()`;

/** 只统计运行中动画，用于 reduced-motion 对比pass */
export const ANIMATION_EXPRESSION = `(() => {
  try {
    const list = document.getAnimations ? document.getAnimations({ subtree: true }) : [];
    const running = list.filter((a) => a.playState === "running");
    const transformish = running.filter((a) => {
      try {
        const frames = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
        return frames.some((f) => f.transform !== undefined && f.transform !== "" && f.transform !== "none");
      } catch (e) { return false; }
    });
    return {
      supported: !!document.getAnimations,
      total: list.length,
      running: running.length,
      runningTransform: transformish.length,
      names: Array.from(new Set(transformish.map((a) => String(a.animationName || a.id || "?")))).slice(0, 10),
    };
  } catch (e) {
    return { supported: false, error: String((e && e.message) || e), total: 0, running: 0, runningTransform: 0, names: [] };
  }
})()`;

/**
 * 判断页面是否"其实还没实现"。
 * 前端桩页面会忽略 hash 路由并渲染固定占位文案，所以不能只看 #root 是否为空。
 */
export function detectUnimplemented(audit) {
  if (!audit) return { implemented: false, reason: "审计脚本没有返回结果" };
  if (!audit.root || !audit.root.exists) return { implemented: false, reason: "页面里没有 #root 容器（index.html 未正确挂载）" };
  if (audit.errorBoundary && audit.errorBoundary.present) return { implemented: true, reason: "出现 #app-error 错误边界", crashed: true };
  if (audit.root.children === 0) return { implemented: false, reason: "#root 没有子节点（React 未渲染任何内容）" };
  const body = (audit.bodyTextSample || "").toLowerCase();
  const hit = PLACEHOLDER_PATTERNS.find((p) => body.includes(p.toLowerCase()));
  if (hit && audit.bodyTextLength < 200) return { implemented: false, reason: `页面只渲染了占位文案「${hit}」，判定该路由尚未实现` };
  if (!audit.h1 && audit.bodyTextLength < 120) return { implemented: false, reason: "页面没有 h1 且可见文本过少，判定该路由尚未实现" };
  return { implemented: true, reason: "" };
}

/**
 * Node 端：把审计结果折成契约检查项。
 * level: fail（退出码非 0）/ warn（需人工确认，不影响退出码）/ info / pass / skipped
 */
export function contractChecks(audit, { implemented = true } = {}) {
  const checks = [];
  const add = (id, label, level, detail) => checks.push({ id, label, level, detail });

  if (!implemented) {
    add("contract", "设计契约断言", "skipped", "页面尚未实现（未渲染真实内容），契约断言不适用 —— 报告中记为 missing 而非通过");
    return checks;
  }

  const c = (audit && audit.contract) || {};
  const verdicts = c.verdicts || { total: 0, invalid: [], counts: {} };
  if (verdicts.total === 0) {
    add("verdict-values", "[data-verdict] 取值合法", "warn", "页面上没有任何 [data-verdict] 徽标；若该页本应有结论徽标，说明契约未落地");
  } else if (verdicts.invalid.length) {
    add("verdict-values", "[data-verdict] 取值合法", "fail", `出现 ${verdicts.invalid.length} 个非法取值：${JSON.stringify(verdicts.invalid.slice(0, 8))}（合法值：${VERDICT_VALUES.join("/")}）`);
  } else {
    add("verdict-values", "[data-verdict] 取值合法", "pass", `${verdicts.total} 个徽标，分布 ${JSON.stringify(verdicts.counts)}`);
  }

  const ledger = c.ledgerNum || { count: 0 };
  const numericLike = c.numericLikeWithoutLedgerClass || [];
  if (ledger.count > 0 && numericLike.length === 0) {
    add("ledger-num", "分值/金额节点命中 .ledger-num", "pass", `.ledger-num ${ledger.count} 处，未发现漏网的裸数字节点`);
  } else if (numericLike.length > 0) {
    add("ledger-num", "分值/金额节点命中 .ledger-num", "warn", `发现 ${numericLike.length} 个疑似分值/金额节点没有 .ledger-num 类（启发式，需人工确认）：${JSON.stringify(numericLike.slice(0, 8))}`);
  } else {
    add("ledger-num", "分值/金额节点命中 .ledger-num", "warn", "页面既没有 .ledger-num，也没有可识别的裸数字节点；无法判定");
  }

  const tenon = c.tenonMissing || { count: 0 };
  if (tenon.count > 0) {
    add("tenon-missing", "无证据结论出现 .tenon--missing", "pass", `.tenon--missing ${tenon.count} 处`);
  } else {
    add("tenon-missing", "无证据结论出现 .tenon--missing", "info", "页面上没有 .tenon--missing。是否有「无证据结论」依赖后端数据，工具无法判定，需人工核对");
  }

  const anim = (audit && audit.animations) || {};
  if (!anim.supported) {
    add("reduced-motion", "reduced-motion 下无 transform 动画", "warn", "当前浏览器不支持 document.getAnimations，无法判定");
  } else if ((anim.runningTransform || 0) > 0) {
    add("reduced-motion", "reduced-motion 下无 transform 动画", "fail", `仍有 ${anim.runningTransform} 个 transform 动画在跑：${JSON.stringify(anim.names)}`);
  } else {
    add("reduced-motion", "reduced-motion 下无 transform 动画", "pass", `无运行中的 transform 动画（总动画 ${anim.total}，运行中 ${anim.running}）`);
  }

  return checks;
}

/** 无障碍硬性检查（这些失败会导致退出码非 0） */
export function a11yChecks(audit, { implemented = true } = {}) {
  const checks = [];
  const add = (id, label, level, detail) => checks.push({ id, label, level, detail });
  if (!audit) {
    add("audit", "无障碍审计", "fail", "审计脚本没有返回结果");
    return checks;
  }

  const ia = audit.interactive || { total: 0, unreachable: [] };
  if ((ia.unreachable || []).length) {
    add("interactive-name", "交互元素可达名称", "fail", `${ia.unreachable.length}/${ia.total} 个可交互元素没有可见文本/aria-label/title：${JSON.stringify(ia.unreachable.slice(0, 6))}`);
  } else {
    add("interactive-name", "交互元素可达名称", "pass", `${ia.total} 个可交互元素全部有可达名称（隐藏元素跳过 ${ia.hiddenSkipped || 0} 个）`);
  }

  const imgs = audit.images || { total: 0, missingAlt: [] };
  if ((imgs.missingAlt || []).length) {
    add("img-alt", "img 必须有 alt", "fail", `${imgs.missingAlt.length}/${imgs.total} 个 img 缺少 alt 属性：${JSON.stringify(imgs.missingAlt.slice(0, 6))}`);
  } else {
    add("img-alt", "img 必须有 alt", "pass", `${imgs.total} 个 img 均有 alt（装饰性空 alt ${imgs.emptyAlt || 0} 个）`);
  }

  if (!audit.lang) add("html-lang", "html[lang] 存在", "fail", "<html> 缺少 lang 属性");
  else add("html-lang", "html[lang] 存在", "pass", `lang="${audit.lang}"`);

  const st = audit.styles || { focusVisible: 0, outlineNone: 0, reducedMotionMedia: 0 };
  if (st.focusVisible > 0) {
    add("focus-visible", ":focus-visible 焦点样式", "pass", `命中 ${st.focusVisible} 条 :focus-visible 规则；outline:none 规则 ${st.outlineNone} 条`);
  } else {
    add("focus-visible", ":focus-visible 焦点样式", st.outlineNone > 0 ? "fail" : "warn", `没有任何 :focus-visible 规则（outline:none 规则 ${st.outlineNone} 条）—— 键盘焦点不可见`);
  }

  if (st.reducedMotionMedia > 0) {
    add("reduced-motion-css", "prefers-reduced-motion 媒体查询", "pass", `命中 ${st.reducedMotionMedia} 条 @media (prefers-reduced-motion: reduce) 规则`);
  } else {
    add("reduced-motion-css", "prefers-reduced-motion 媒体查询", "warn", "样式表里没有 @media (prefers-reduced-motion: reduce) 规则");
  }

  if (!implemented) {
    add("page-impl", "页面已实现", "skipped", "页面未渲染真实内容，以上无障碍结论只反映占位页面");
  }
  return checks;
}

/** 把 level 折成是否影响退出码 */
export function levelFails(level) {
  return level === "fail";
}

/** 可读的检查行 */
export function formatChecks(checks) {
  const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO", skipped: "SKIP" };
  return checks.map((c) => `  [${icon[c.level] || c.level}] ${c.label} — ${c.detail}`);
}

/** 汇总一批检查项 */
export function summarizeChecks(checks) {
  const s = { pass: 0, fail: 0, warn: 0, info: 0, skipped: 0 };
  for (const c of checks) s[c.level] = (s[c.level] || 0) + 1;
  return s;
}
