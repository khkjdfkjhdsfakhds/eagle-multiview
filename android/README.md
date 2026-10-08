# Eagle MultiView Android

This directory contains the native Kotlin/AndroidX shell for the Eagle MultiView mobile web client. It uses one application ID (`com.eaglemultiview.android`) for both phones and tablets.

## Toolchain

- JDK 17
- Android SDK Platform 35
- Android SDK Build-Tools 35.x or newer
- Android Gradle Plugin 8.7.3
- Gradle Wrapper 8.9
- A phone or tablet emulator/device running Android 8.0 (API 26) or newer

Set `ANDROID_HOME` (or create an untracked `local.properties` containing `sdk.dir=...`) and make sure JDK 17 is selected through `JAVA_HOME`.

## Commands

Run commands from this `android/` directory:

```sh
./gradlew testDebugUnitTest
./gradlew assembleDebug
./gradlew lintDebug
./gradlew connectedDebugAndroidTest
```

The debug APK is produced at `app/build/outputs/apk/debug/app-debug.apk`. `connectedDebugAndroidTest` needs one booted API 26+ emulator or connected Android device with a working WebView provider.

`python3 tools/run-host-url-probe.py` is an optional offline check of the original URL validator and trust policy, using existing JDK 17 / Kotlin 2.2.20 caches without downloads or Gradle changes. It checks encoded-path restore identity and port boundaries; it does not replace the project-locked JVM suite, Activity build, or device acceptance.

## Current host/WebView contract

- The first screen accepts typing or pasting an HTTP/HTTPS MultiView host URL. Missing schemes are normalized to `http://` for LAN use.
- Only normalized HTTP/HTTPS origins are accepted. Credentials, query strings, fragments, unsupported schemes, malformed hosts, and invalid ports are rejected with an actionable native error.
- A host is remembered only after a trusted same-origin page (including the existing `/login` page) commits successfully. A normal restart attempts the last successful host; an error state or the change-host action can replace it.
- The WebView shows distinct native states for connecting, unreachable hosts, HTTP errors, TLS/certificate failures, and expired login sessions. Each recoverable state has retry and/or change-host actions, and failed main-frame loads never leave a blank WebView.
- JavaScript, DOM storage, first-party cookies, and media playback are enabled for the existing MultiView web client. Third-party cookies, file access, and content access are disabled.
- The existing Web login page remains responsible for submitting the access key and setting the HttpOnly session cookie. Android does not store or log the access key, session cookie, or full navigated URL.
- Only same-origin HTTP/HTTPS MultiView navigation stays in the trusted WebView. Other web origins open with the system browser; unsupported schemes are blocked. No page-callable `addJavascriptInterface` bridge is exposed.
- Android system Back (button or gesture, through the AndroidX `OnBackPressedDispatcher`) makes one native-initiated `evaluateJavascript` call to `window.EagleMVBack.request()` only after a trusted same-origin page commits. `handled` and `blocked` stay in the page; only a complete, valid `exit` result finishes the Activity.
- Back requests are serialized and timed out. Loading, failed, crashed, untrusted, malformed-result, exception, and stale-callback paths remain open in a recoverable native state rather than bypassing the Web return contract. Renderer loss replaces the unusable WebView before retry.
- Replacing the trusted host clears WebView cookies, storage, cache, form data, and history before the new host is loaded, preventing cross-host session reuse.
- Startup offline, DNS/service failures, and main-frame load failures enter explicit recoverable states. Network return runs one read-only authenticated `/health/session` probe and at most one safe page navigation for that outage; it never replays an RPC or loops reloads.
- A page that has already loaded rides out a network loss or handoff on its own: no native failure screen and no reload afterwards, so its folder, preview, and drafts survive. The web client shows its own offline banner and reconnects when the network returns. Only a page that fails a load of its own while offline falls back to the recovery path above.
- Host generations invalidate stale network, health-probe, and WebView callbacks. Switching hosts or destroying the Activity also cancels pending recovery ownership, while an expired session returns to the existing `/login` flow.
- The web shim independently reconnects its same-origin `/events` WebSocket with one timer and one health probe, then emits the existing reconnect synchronization signals after a new socket session is established.
- WebView file/content access is disabled. The manifest requests only network access; it does not request storage or Eagle-library file permissions.
- The WebView user agent ends with `EagleMultiViewAndroid/<versionName>`. The web shim uses it to report `capabilities.multiWindow = false`: the shell has a single window and no popups (`window.open` would replace the page), so "new window" entries are hidden there and their shortcuts explain the split-pane alternative.
- Full-screen video (`<video controls>`) uses `onShowCustomView`; system Back (or an unconsumed Esc) leaves full screen before it reaches the page, and any navigation or teardown exits it.
- The launcher icon is the desktop app's icon (`assets/icon.icns`) as an adaptive icon in `res/mipmap-*`, on the icon's own edge blue. The native screens use a light theme regardless of system dark mode, since they are drawn with fixed light colours.

- Hardware keyboards: the trusted page receives every key first, so all shortcuts live in the web client. The WebView takes focus when a trusted page commits and whenever the window regains focus (returning from background or the file picker). Keys the page does not consume are handled natively: Esc runs the same `window.EagleMVBack.request()` path as system Back (once per press), arrows and Tab never move focus to native controls, and Alt/Ctrl/Meta+Esc keep Android's fallbacks. Some systems (HyperOS, the emulator's qwerty2 layout) rewrite a keyboard's Esc into Back before apps see it; `ShellWebView` recognizes that Back by its Esc scan code ahead of the IME and hands the page a real Esc instead, so Esc leaves text fields, closes dialogs, and clears the selection exactly as on the desktop. This needs `enableOnBackInvokedCallback="false"` (with the callback API the platform drops Back keys before any view sees them); the shell never animated predictive back, so nothing visible is lost. Attaching or detaching a keyboard, rotating, split screen, and freeform resizing do not recreate the Activity or reload the page; the web client keeps its folder, preview, and drafts while only width-qualified native paddings are refreshed.
- Import: `<input type="file">` opens the system picker (`ACTION_GET_CONTENT`, multi-select when the page asks, `accept` mapped to MIME filters, otherwise any file). Every outcome — selection, cancel, launch failure, a newer request, page/renderer/host teardown — answers the WebView callback exactly once, so the next "Import" always opens again. Only the picked content URIs reach the page; no storage permission is requested.
- Download: WebView downloads from the active same-origin host (the web client's "download to this device") are handed to the system `DownloadManager` with the page's session cookie and User-Agent, named from the host's RFC 5987 `filename*`, saved to Downloads (Android 10+; app-scoped Downloads on 8–9, which have no permission-free shared folder), and announced by the system notification. Other origins and `blob:`/`data:` URLs are refused. Note: `DownloadManager` keeps request headers, including that cookie, in its own database for the download record's lifetime.

Release signing is intentionally left to a later decision; debug builds use the local debug keystore.

## Git hygiene

`android/.gitignore` excludes Gradle/IDE build state, APK/AAB outputs, `local.properties`, signing material, and local keystore configuration. Do not commit host addresses, cookies, device credentials, or release signing keys.
