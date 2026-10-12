# Eagle MultiView 1.8.3

Android App 连上主机后很少再回到连接页，原来放在那里的“检查更新”和“更换主机”平时找不到。这一版把它们放进了资料库菜单。

## Android App

- 点侧边栏顶部的资料库名称，菜单底部新增“Eagle MultiView App <版本>”一栏：
  - **检查更新…**：立即检查新版本，流程与连接页的“检查更新”相同。
  - **更换主机…**：确认后回到连接页，地址栏保留当前地址。确认框会说明当前登录是否保留：勾选了“记住访问地址”时保留，否则离开后需要重新登录。有未保存的 TXT 时会先照常提示。
- 每天一次的自动检查不变。

> 1.8.2 的 App 会在自动检查或连接页“检查更新”中发现这一版，可直接在 App 内更新。

## 桌面与网页

- 无功能变化。网页端只有在 Android App 中才显示这两项。

完整列表见 [CHANGELOG](https://github.com/khkjdfkjhdsfakhds/eagle-multiview/blob/v1.8.3/CHANGELOG.md)。

## 下载与升级

- macOS Apple silicon：`Eagle-MultiView-1.8.3-arm64.dmg`。临时本机签名，未经 Apple 公证；首次打开请在 Finder 中右键选择“打开”。1.8.2 可在 App 内更新。
- Android：`Eagle-MultiView-1.8.3-android.apk`（debug 签名，与之前版本相同，可直接覆盖安装并保留数据）。
- 校验文件：`SHA256SUMS.txt`。
- 编辑 TXT 仍需在 Eagle 中启用 App 随附的后台保存插件，见[启用说明](https://github.com/khkjdfkjhdsfakhds/eagle-multiview/blob/v1.8.3/eagle-plugin/text-save-service/README.md)。
- 内置 Web 服务为 HTTP，仅用于可信局域网，不要直接映射到公网。
- 不提供 Windows 桌面版。
