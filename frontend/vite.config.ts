import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 离线开发/构建：依赖来自随仓库复制的 frontend/node_modules（见 README-offline.md）。
// 开发服务器把 /api 代理到本机后端 127.0.0.1:8000，避免开发期跨域配置漂移。
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
