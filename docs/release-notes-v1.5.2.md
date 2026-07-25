# Eagle MultiView 1.5.2

Eagle MultiView 可以让同一个 Eagle 资料库同时在多个窗口和分栏中浏览、搜索、筛选、预览、整理、导入与编辑，并通过 Eagle 本地 HTTP API 同步修改。

## 本次更新

- 新增单栏、双栏、三栏和四栏布局；每个分栏独立保留文件夹、搜索、筛选、选择、滚动和预览状态。
- 新增文件夹、TXT/其它文档和智能文件夹创建流程。
- 新增素材导出、创建副本、原生文件复制、拖出到 Finder、默认应用打开和文件管理器定位。
- 新增 NovelAI、Stable Diffusion WebUI、ComfyUI、InvokeAI 等常见图片生成信息读取。
- 完善拖入文件夹、跨分栏与跨窗口归类的完整拖放生命周期，修复拖放后界面卡住的问题。
- 批量文件夹、标签、评分、回收站、恢复、导出和副本操作加入并发限制、单项超时与部分失败反馈。
- 保存、导入、置顶、TXT 编辑和后台刷新会持续绑定到发起操作的分栏，避免慢请求覆盖其它视图。
- 新建文件夹使用 `Option-N`，新建 TXT 使用 `Option-Shift-N`，新窗口使用 `Command-Option-N`。
- 修复竖向文件夹封面裁切、后台查询误报全局离线、回收站扫描长时间不结束等问题。

## 下载

- **macOS Apple silicon**：`Eagle-MultiView-1.5.2-arm64.dmg`
- **Windows x64 实验性版本**：`Eagle-MultiView-1.5.2-Setup.exe`
- **校验文件**：`SHA256SUMS.txt`

macOS 是本项目主要支持并实际验证的平台。macOS 安装包使用临时本机签名，未经过 Apple 公证。

Windows 安装包是根据当前源码生成的未签名实验性版本，**未完成 Windows 实机或虚拟机 GUI 回归，后续不承诺兼容性修复、更新或维护**。Windows 用户应自行评估后使用；部分 macOS 专属操作在 Windows 上可能不可用或行为不同，Windows SmartScreen 也可能显示未知发布者提示。

## 使用前提与数据边界

- 需要 Eagle 4.0 Build 21 或更新版本，并先在 Eagle 中打开目标资料库。
- MultiView 通过 Eagle 本机 HTTP API 读取和修改资料；不会上传资料库内容。
- 素材属性、归类、导入和回收站操作通过 Eagle API 完成，不直接重写 Eagle 的资料库元数据。
- MultiView 不提供永久删除；移入回收站的素材仍可在 Eagle 中恢复。
