/**
 * frontend/scripts/dom-shim.mjs
 *
 * 极简 DOM 实现：只够 React 19 的 react-dom/client 把组件树挂起来并提交更新。
 * 本机沙箱内没有任何浏览器可启动（见 docs/TESTING.md 的失败证据），也没有 jsdom，
 * 所以这里是"在 Node 里跑真组件树"的唯一落点。
 *
 * 明确不做：CSSOM、布局、命中测试、事件冒泡、表单真实行为。
 * 因此它只能验证"渲染出了什么节点/属性"，不能验证"看起来怎么样"。
 */

class ShimNode {  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
    this._listeners = new Map();
    this.style = {};
    this.nodeValue = "";
    // React 的 host context 判定依赖 namespaceURI / tagName / localName，
    // 缺一个就会在 pushHostContainer 里对 undefined 调 toLowerCase。
    this.namespaceURI = nodeType === 1 ? "http://www.w3.org/1999/xhtml" : null;
  }

  get tagName() {
    return this.nodeName;
  }

  get localName() {
    return this.nodeType === 1 ? this.nodeName.toLowerCase() : null;
  }

  /**
   * React 的 getActiveElementDeep 把 root.containerInfo 当作"有 document 属性的东西"
   * （真实 DOM 里 container 是 Document）。元素上没有 document，就补一个指回 ownerDocument。
   */
  get document() {
    if (process.env.DOM_SHIM_TRACE === "1") {
      console.log(`[shim] get document on <${this.nodeName}> -> ownerDocument=${this.ownerDocument?.nodeName}`);
    }
    return this.ownerDocument;
  }

  get HTMLIFrameElement() {
    const value = this.ownerDocument?.HTMLIFrameElement ?? null;
    if (process.env.DOM_SHIM_TRACE === "1") {
      console.log(`[shim] get HTMLIFrameElement on <${this.nodeName}> -> ${typeof value}`);
    }
    return value;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, anchor) {
    if (!anchor) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.childNodes.indexOf(anchor);
    if (index < 0) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  replaceChild(next, previous) {
    const index = this.childNodes.indexOf(previous);
    if (index >= 0) {
      if (next.parentNode) next.parentNode.removeChild(next);
      this.childNodes[index] = next;
      next.parentNode = this;
      previous.parentNode = null;
    }
    return previous;
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
  }

  getAttribute(name) {
    const value = this._attrs.get(String(name));
    return value === undefined ? null : value;
  }

  setAttributeNS(_ns, name, value) {
    this.setAttribute(name, value);
  }

  hasAttribute(name) {
    return this._attrs.has(String(name));
  }

  removeAttribute(name) {
    this._attrs.delete(String(name));
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this._listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this._listeners.get(event?.type) ?? []) listener.call(this, event);
    return true;
  }

  focus() {}
  blur() {}
  click() {}

  set textContent(value) {
    this.childNodes = [];
    if (value !== "" && value != null) this.appendChild(new ShimText(String(value), this.ownerDocument));
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get innerHTML() {
    return this.childNodes.map((child) => child.outerHTML ?? child.textContent).join("");
  }

  set innerHTML(_value) {
    this.childNodes = [];
  }

  get outerHTML() {
    const attrs = [...this._attrs].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
    return `<${this.nodeName.toLowerCase()}${attrs}>${this.innerHTML}</${this.nodeName.toLowerCase()}>`;
  }
}

class ShimText extends ShimNode {
  constructor(text, ownerDocument) {
    super(3, "#text", ownerDocument);
    this.nodeValue = text;
  }

  get textContent() {
    return this.nodeValue;
  }

  set textContent(value) {
    this.nodeValue = String(value);
  }
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/* ---------- 选择器：只实现组件里真正用到的几种 ---------- */

function matchesSimple(node, selector) {
  let rest = selector;
  const attrPattern = /\[([a-zA-Z0-9_:.-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]/g;
  let match;
  while ((match = attrPattern.exec(selector))) {
    const [, name, operator, expected] = match;
    const actual = node.getAttribute(name);
    if (actual === null) return false;
    if (operator === "=" && expected !== undefined && actual !== expected) return false;
    if (operator === "*=" && !actual.includes(expected)) return false;
    rest = rest.replace(match[0], "");
  }

  const idPattern = /#([a-zA-Z0-9_:.-]+)/;
  const idMatch = idPattern.exec(rest);
  if (idMatch) {
    if (node.getAttribute("id") !== idMatch[1]) return false;
    rest = rest.replace(idMatch[0], "");
  }

  const classPattern = /\.([a-zA-Z0-9_-]+)/g;
  const classes = [];
  let classMatch;
  while ((classMatch = classPattern.exec(rest))) classes.push(classMatch[1]);
  if (classes.length) {
    const own = new Set((node.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
    if (!classes.every((name) => own.has(name))) return false;
    rest = rest.replace(classPattern, "");
  }

  const tag = rest.trim();
  if (tag && node.nodeName.toLowerCase() !== tag.toLowerCase()) return false;
  return true;
}

function queryAll(root, selector) {
  // 只支持逗号分隔的简单选择器组（见 matchesSimple 的限制）。
  const groups = String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const found = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        if (groups.some((group) => matchesSimple(child, group))) found.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

/* ---------- 文档与容器 ---------- */

export function createDom() {
  const document = {
    nodeType: 9,
    nodeName: "#document",
    childNodes: [],
    _listeners: new Map(),
    documentElement: null,
    body: null,
    head: null,
    title: "",
    createElement(tag) {
      return new ShimNode(1, String(tag).toUpperCase(), document);
    },
    createElementNS(_ns, tag) {
      return new ShimNode(1, String(tag).toUpperCase(), document);
    },
    createTextNode(text) {
      return new ShimText(String(text), document);
    },
    createDocumentFragment() {
      return new ShimNode(11, "#document-fragment", document);
    },
    createComment(text) {
      const node = new ShimNode(8, "#comment", document);
      node.nodeValue = String(text);
      return node;
    },
    addEventListener(type, listener) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      this._listeners.get(type)?.delete(listener);
    },
    dispatchEvent() {
      return true;
    },
    querySelector(selector) {
      return queryAll(document.documentElement ?? document, selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return queryAll(document.documentElement ?? document, selector);
    },
    getElementById(id) {
      return queryAll(document.documentElement ?? document, `#${id}`)[0] ?? null;
    },
  };

  document.documentElement = document.createElement("html");
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  document.childNodes.push(document.documentElement);

  // React 会读 document.document（活动元素判断）与若干构造器；shim 统统指回 document 自己。
  document.document = document;
  document.defaultView = globalThis.window ?? globalThis;
  document.activeElement = document.body;
  document.HTMLIFrameElement = ShimNode;
  document.Node = ShimNode;
  document.Element = ShimNode;
  document.HTMLInputElement = ShimNode;
  document.HTMLTextAreaElement = ShimNode;
  document.HTMLSelectElement = ShimNode;
  document.HTMLButtonElement = ShimNode;
  document.SVGElement = ShimNode;

  /** 造一个可以传给 createRoot().render() 的容器，并挂到 body 下。 */
  document.createContainer = () => {
    const container = document.createElement("div");
    container.setAttribute("id", "root");
    document.body.appendChild(container);
    return container;
  };

  return document;
}

export { ShimNode };

/** 把整个 body 序列化成 HTML 字符串（用于留痕与断言）。 */export function serialize(node) {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType === 8) return `<!--${node.nodeValue}-->`;
  const tag = node.nodeName.toLowerCase();
  const attrs = [...node._attrs].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  const inner = node.childNodes.map(serialize).join("");
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/** 在子树里按选择器取节点（同 queryAll 的限制）。 */
export function select(root, selector) {
  return queryAll(root, selector);
}
