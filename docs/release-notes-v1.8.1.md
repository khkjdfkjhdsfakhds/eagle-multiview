# Eagle MultiView 1.8.1

在 Mac 上多窗口、多分栏整理 Eagle 素材；手机、平板和另一台电脑可通过浏览器或新的 Android App 使用同一资料库。

## 新增：Android App

手机和平板通用（Android 8.0 及以上）。App 连接的就是 Mac 上的“Web 访问”服务，界面与浏览器一致，但系统操作不再和网页操作冲突：

- **系统返回键和边缘手势**按网页层级逐步返回：先关菜单、弹窗和预览，再退出手机选择栏，然后沿浏览历史后退；没有历史时才退出 App。
- **外接键盘**：网页先收到所有按键。Mac 上用 ⌘ 的快捷键在 Android 上改用 Ctrl，例如 Ctrl+1–4 切换分栏、Ctrl+[ / ] 后退前进、Ctrl+Shift+L / I 收起文件夹栏和检查器，提示文字也会显示为 Ctrl/Alt/Shift。方向键和 Tab 不会把焦点移到原生控件上。
- **Esc 与 Mac 一致**：离开输入框、关闭弹窗和预览、清除选择；网页没有用到的 Esc 才算一次返回。小米 HyperOS 会在系统层把键盘 Esc 改成“返回”，App 已做还原处理。
- **导入**使用系统文件选择器，可多选，不申请存储权限；**“下载到此设备”**通过系统下载管理器保存单个文件或 ZIP 到“下载”目录，并显示完成通知。
- 平板横屏宽度足够时可用多栏；横竖屏切换、分屏、小窗和接拔键盘都不重新加载页面；系统字体调大后文件夹卡片的文字不再重叠。
- 页面上方没有原生工具栏，状态栏颜色跟随页面。需要换到另一台 Mac 时，在连接失败页或登录页点“更换主机”。
- 从后台或文件选择器回来后，立即恢复实时同步。

安装：下载 `Eagle-MultiView-1.8.1-android.apk`，在设备上打开安装（需要允许当前来源安装应用）。打开 App，输入 Mac 上“显示 → Web 访问…”窗口显示的地址（例如 `http://192.168.1.20:41600`）和访问密钥。Eagle、MultiView 和 Mac 必须保持运行，并与设备处于同一局域网。

> 当前 APK 使用开发（debug）签名，适合个人侧载使用。以后改为正式签名时，需要先卸载这一版再安装。

已在 Android 16 模拟器（手机、平板）和小米 Pad 8 Pro（HyperOS 3）上验证返回、键盘、导入和下载。鼠标/触控板的悬停和右键尚未在真机上测试。

## 桌面与网页

- **Ctrl/⌘+Z 撤销删除**：撤销最近一次移入废纸篓（每个窗口最多保留 20 批），也可用“编辑 → 撤销”；现在浏览器和 Android App 同样可用。输入框内仍然是文字撤销。
- 废纸篓里已有同一文件时重新导入，按新素材导入，与 Eagle 一致，不再报“重复素材处理失败”。
- 素材拖到另一栏的**素材卡片**上，会移入（按住 Option 复制到）那一栏的文件夹；同一文件夹内拖动仍是排序。
- 点击另一栏时，第一栏的 TXT 编辑器会自动保存并交出焦点，在另一栏粘贴不会再把文件路径写进 TXT。
- 同步预览时，选择会收拢到正在预览的素材，并滚动到可见位置。
- Metadata Viewer 读取 PNG / WebP 透明通道中隐藏的 NovelAI 生成信息；支持键盘缩放和右下角调整高度。
- 右键交换两个分栏；剪贴板和拖入文件夹的重复导入在 MultiView 内选择处理方式；新建文件夹在 Eagle 和 MultiView 中都排到最前。
- 复制文件夹完整保留名称、素材与文件夹顺序、置顶、封面、属性和素材元数据；拖动文件夹到另一栏可移动，按住 Option 复制整棵子树。
- MultiView TXT 插件新增“在 Eagle 打开 MultiView 当前文件夹”。

完整列表见 [CHANGELOG](https://github.com/khkjdfkjhdsfakhds/eagle-multiview/blob/v1.8.1/CHANGELOG.md)。

## 下载与升级

- macOS Apple silicon：`Eagle-MultiView-1.8.1-arm64.dmg`。临时本机签名，未经 Apple 公证；首次打开请在 Finder 中右键选择“打开”。
- Android：`Eagle-MultiView-1.8.1-android.apk`（debug 签名）。
- 校验文件：`SHA256SUMS.txt`。
- 编辑 TXT 仍需在 Eagle 中启用 App 随附的后台保存插件，见[启用说明](https://github.com/khkjdfkjhdsfakhds/eagle-multiview/blob/v1.8.1/eagle-plugin/text-save-service/README.md)。
- 内置 Web 服务为 HTTP，仅用于可信局域网，不要直接映射到公网。
- 不提供 Windows 桌面版。
