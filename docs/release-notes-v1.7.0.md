# Eagle MultiView 1.7.0

This release promotes the reviewed branch changes into the formal Eagle MultiView app and removes the need for a parallel Review installation.

## Highlights

- WebP images now expose embedded NovelAI EXIF metadata in the Metadata panel.
- Folder sorting and direction are remembered more consistently across navigation.
- Path navigation, preview controls, scroll restoration, pane synchronization, and narrow-window behavior include the accumulated review fixes.
- Eagle folder names retain Eagle's logical naming rules.
- WebP items use a compatible thumbnail fallback during native macOS drag operations.

## Validation target

- Formal bundle identifier: `local.eagle.multiview`
- Formal app name: `Eagle MultiView`
- macOS target: Apple silicon (`arm64`)

The Review bundle is retired only after the formal build passes automated, signed-build, installed-app, and GUI verification.
