# 本机依赖说明

前端依赖位于 frontend/node_modules，版本见 package.json。TypeScript 已从临时验收目录迁入 frontend/node_modules/typescript，构建不再依赖 .verification。

开发和构建前设置 `$env:DSH_NO_NET_USE='1'`。本机 Vite 依赖内有针对受限 Windows 环境 net use 探测的补丁，重新安装依赖会覆盖该补丁。普通终端通常不需要此补丁。

依赖、构建产物和业务数据不纳入 Git；在新机器上需要按 package.json 安装依赖。src/demo/fixtures 是前端运行时演示素材，已纳入 Git，不要当作临时测试目录删除。
