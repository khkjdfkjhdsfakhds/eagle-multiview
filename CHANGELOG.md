# Changelog

All notable public changes to Eagle MultiView are recorded here.

## 1.5.2 - 2026-07-25

### Multi-pane workspace

- Added single, two-pane, three-pane, and four-pane layouts inside each window.
- Kept folder, search, filter, selection, scroll, preview, and inspector state independent for every pane.
- Bound delayed imports, bulk writes, inspector saves, TXT saves, pin updates, and refreshes to the pane that started them.

### Creation, organization, and file actions

- Added Eagle-style creation flows for folders, TXT and other supported documents, and smart folders.
- Added export, duplicate creation, native file copying, Finder dragging, default-app opening, and file-manager reveal actions.
- Added duplicate detection for imports and safer partial-success handling for bulk folder, tag, rating, trash, restore, export, and duplicate operations.
- Matched Eagle's folder-removal versus trash behavior when an item belongs to more than one folder.

### Metadata and navigation

- Added local reading for common NovelAI, Stable Diffusion WebUI, ComfyUI, and InvokeAI generation metadata.
- Expanded folder navigation, smart-folder conversion, history, multi-pane refresh behavior, and keyboard shortcuts.
- Added `Option-N` for folders, `Option-Shift-N` for TXT documents, and `Command-Option-N` for new windows without intercepting `Command-N`.

### Drag, drop, and asynchronous reliability

- Reworked native and HTML5 drag lifecycles so folder drops release the pointer session before Eagle API writes begin.
- Preserved source window, source pane, source folder, and library identity across cross-window and cross-pane drops.
- Added bounded concurrency, per-item timeouts, partial-failure reporting, close blocking for high-risk writes, and stale-response protection.
- Prevented slow background refreshes or failed pane queries from repainting unrelated panes or disabling the whole application.

### Folder covers and interface

- Matched Eagle's folder-card proportions, stacked sheet spacing, and dark radial cover surface.
- Fixed portrait folder covers being scaled by width and vertically clipped into a landscape strip.
- Kept Eagle's single-cover behavior while centering portrait, square, and landscape covers at their original aspect ratio.

### Windows experimental build

- Added a Windows x64 NSIS build and Windows application icon.
- The unsigned Windows artifact is provided from the current source without Windows hardware/VM GUI validation and without a maintenance commitment.

### Validation

- Added regression coverage for pane isolation, drag/drop lifecycle, asynchronous operations, shortcuts, smart folders, duplicate handling, metadata reading, exporting, new-file creation, Trash scanning, folder covers, and Eagle API behavior.
- Passed JavaScript syntax checks and the full automated test suite.
- Verified the signed arm64 installed app with an isolated public test-library copy; Windows runtime behavior remains unverified.

## 1.5.1 - 2026-07-23

### Library navigation

- Added Eagle-style sidebar entries for Recent, Random, Trash, Quick Access, and Smart Folders.
- Added recent-folder loading through Eagle's API and random ordering through Eagle item queries.
- Added a read-only Trash listing backed by deleted-item metadata scanning; restore and trash actions still go through Eagle.
- Preserved nested folder trees, folder cards, direct-child browsing, path navigation, and `/` expand/collapse positioning.

### Context menu and organization

- Replaced the renderer's basic context menu with an Eagle-style custom menu, including icons, separators, shortcut hints, hover states, and submenus.
- Added multi-item add/move/remove folder operations, tag assignment, rating, pinning, trash, and restore actions.
- Kept native main-process IPC context actions as a compatibility path.
- Added intent-based set mutations so concurrent tag and folder edits merge against the latest Eagle state.

### Filters, tags, and inspector

- Rebuilt keyword, extension, rating, and tag filters as a compact Eagle-style popover.
- Added a local tag color manager. Colors are stored in MultiView's own user-data directory because Eagle's public API does not expose tag-color updates.
- Split the inspector into Preview, Basic Information, Notes and Source, and File Information sections.
- Added a file-format badge to the inspector preview.

### Thumbnails and preview

- Removed PNG, JPG, JPEG, WEBP, GIF, SVG, AVIF, BMP, HEIC, TIFF, and TIF badges from image thumbnails.
- Kept format badges for PSD, TXT, PDF, audio, video, and other non-image formats.
- Added image Fit, Actual Size, zoom-in/out, wheel zoom, drag-to-pan, and current-position controls.
- Fixed tall and high-resolution images being laid out at intrinsic size in Fit mode. Fit now constrains both axes and shows the entire image inside the viewport.
- Kept Actual Size and zoomed images pannable, including at 100% scale.

### Reliability and safety

- Added Eagle library-switch invalidation for item caches, visible-item watchers, and queued mutations.
- Added cross-window broadcasts and field-level conflict checks for edits.
- Kept TXT external-change detection, recovery backups, and atomic saving.
- Added a bounded Trash metadata scan with an explicit retry state so an unavailable library directory cannot leave the interface stuck on the previous view.
- Added tests for recent folders, random queries, trash filtering behavior, and library switching.

### Interface

- Updated the app to Eagle's neutral dark palette and reused selected local Eagle interface icons.
- Added the original Eagle MultiView double-window mascot icon.
- Improved narrow-window layout, toolbar density, card metadata, selection states, and status feedback.

### Validation

- Passed syntax checks for `main.js`, `preload.js`, and `src/renderer.js`.
- Passed all 32 automated tests.
- Verified the signed arm64 installed app with a 1,484-item public demo library.
- Verified multi-window launch, folder hierarchy, preview navigation, long-image Fit, Actual Size, drag-to-pan, filters, context menus, inspector, and close/selection restoration.

## 1.5.0 - 2026-07-22

- Introduced the original double-window app icon.
- Reworked the title bar, toolbar, sidebar, grid, inspector, status bar, and preview visual hierarchy.
- Added safer title-bar spacing for macOS window controls.

## Initial public baseline

- Added independent MultiView windows for a running Eagle library.
- Added direct-child folder browsing, search, filters, preview, import, editing, and cross-window synchronization.
- Added conflict-aware metadata writes and TXT recovery handling.
