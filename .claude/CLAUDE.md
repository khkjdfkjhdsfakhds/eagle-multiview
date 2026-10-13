# Eagle MultiView — 云端 / 通用协作规则

本文件随仓库提交，供 Claude Code 云会话（claude.ai/code）和任何没有本机私有说明的环境使用。本机还有未提交的完整说明，与本文件冲突时以本机说明为准。默认用中文与用户协作，回复精简。

## 项目目标

Eagle MultiView 是以 Eagle HTTP API 为数据与修改边界、面向 macOS Eagle 用户的完整多窗口客户端（另有网页端与 Android 外壳，见 `android/`）。目标是在不修改 Eagle 资料库结构的前提下，让同一资料库可同时打开多个窗口，并在浏览、整理、预览、导入、编辑、快捷操作和同步上完整看齐 Eagle 原版。技术栈：Electron、原生 Node.js、Eagle HTTP API。

## 数据安全边界（任何环境都适用）

- 不得删除、重命名、移动或重写 Eagle 资料库中的图片、文件夹、元数据或索引文件；修改元数据只能通过 Eagle API，并保留跨窗口冲突检查。
- MultiView 的持久化状态只写入自身 Electron userData 目录。
- 导入、拖放、剪贴板粘贴和默认应用打开只作用于用户明确选择的文件。
- API 不支持某项原版能力时，如实说明限制，不得绕过 API 直接改资料库，也不得把行为不同的替代品当作已对齐。

## 云会话能做什么、不能做什么

云会话是 Linux 容器，没有 macOS、没有 Eagle、没有用户资料库。

- **可以**：改代码、`node --check`、`node --test`、写测试、推送到新分支（不要直接推 `main`）。
- **不能**：`electron-builder --mac` 打包与签名、安装到 `/Applications`、GUI 验证、连接 Eagle API（`localhost:41595`）、Android 构建/模拟器验证。这些由用户在本机会话完成。
- 本机规则“改完代码必须构建并安装”在云端不适用；在最终报告里写明“构建/安装/GUI 验证待本机完成”。
- 不得伪造或推测 GUI/真机验证结果。

## 开发与验证

- 优先遵循现有结构，避免无关重构；用精确的局部编辑，不整文件覆盖。
- 修改后至少运行：

```sh
node --check main.js
node --check preload.js
node --check src/renderer.js
node --test --test-force-exit
```

- 部分测试依赖 Electron 窗口或本机环境（例如 `interaction-regression`、`interaction-final-review` 等打开 `http://0.0.0.0` 的用例），在云端或无显示环境下可能失败。区分“环境失败”与“本次改动导致的失败”：在改动前先跑一次记录基线，不要为了通过而修改无关测试。
- 少数用例（如 pane-reveal）有并发偶发失败，单独重跑确认。

## 已确认的工程结论

- `window.eagleMV` 是 contextBridge 冻结对象，页面里不能打桩。
- 改了被 `lib/` require 的 `src/` 模块（如 `src/query-spec.js`、`src/pane-state.js`）后，开发版必须重启主进程才生效。
- 模块顶层 `let` 若在模块初始化期调用的函数之后声明，会因暂时性死区导致启动白屏，源码断言测试查不出。
- Eagle API 限制：`/api/v2/item/get` 忽略 orderBy 和所有范围参数（大小、分辨率、日期），这些筛选走客户端扫描管线；没有删除文件夹、文件夹重排/改父级等端点。item 对象在 star=0 或备注为空时省略该字段；`btime` 可用。
- 排序记忆（`src/sort-memory.js`）每库有条目上限，子树排序用 `cascade:folder:<id>` 标记，不要改回逐个写入子孙文件夹。

## Eagle 体验对齐

- 以“操作体验完整看齐 Eagle 原版”为基准：从入口、悬停/拖动、目标反馈、执行、取消、异常、跨窗口同步到界面刷新的完整工作流都要收尾。
- 云端无法观察 Eagle 原版行为；对操作语义、修饰键、文案、菜单层级不确定时，不得宣称已对齐，在报告里列为“待本机核对”。
- 可见文本、按钮在窄窗口下不重叠、不溢出；强调色用 Eagle 风格蓝色，避免大面积蓝紫背景。

## Git 与 GitHub

- 提交前运行 `git status -sb`、`git diff --stat`、`git diff --cached --name-only`；只暂存本次明确修改的文件，禁止无检查的 `git add .` / `git add -A`。
- 不得提交 `node_modules/`、`dist/`、`.codex-local/`、`AGENTS.override.md`、聊天记录、截图、日志、私人 Eagle 数据、安装包或密钥。
- 本仓库是公开仓库：提交、文档、PR 中不得出现本机绝对路径、资料库名称或内容、token、cookie。
- 不改版本号、不打标签、不发 Release，除非用户明确要求（发布需要本机构建的 DMG/APK）。

## 交付报告

最终报告区分：源码改动、自动测试（含环境失败说明）、未完成的验证（构建、签名、安装、GUI、多窗口、Android）。同时给出一段“交接摘要”（改了什么、为什么、已知风险、本机需要验证的具体操作），方便本机会话写入本机交接记录。
