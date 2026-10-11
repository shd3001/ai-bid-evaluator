import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

import { App, boot } from "./app/App";
import { initTheme } from "./utils/theme";

// 先把主题写到 <html data-theme>，再渲染，避免深色偏好下先闪一帧白底。
initTheme();

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

const container = createRoot(root);

// 先探测后端是否就绪，再决定 live / demo：探测本身不阻塞页面结构，失败也会渲染（回落到离线夹具）。
boot()
  .then((probe) => {
    container.render(
      <StrictMode>
        <App probe={probe} />
      </StrictMode>,
    );
  })
  .catch((cause: unknown) => {
    // 探测函数本身理论上不会抛错；真抛了也要让用户看到，而不是白屏。
    container.render(
      <StrictMode>
        <div className="boot boot--failed">
          <h1>启动失败</h1>
          <p className="muted">{cause instanceof Error ? cause.message : String(cause)}</p>
        </div>
      </StrictMode>,
    );
  });
