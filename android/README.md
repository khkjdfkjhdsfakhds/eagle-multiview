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
./gradlew connectedDebugAndroidTest
```

The debug APK is produced at `app/build/outputs/apk/debug/app-debug.apk`. `connectedDebugAndroidTest` needs one booted API 26+ emulator or connected Android device with a working WebView provider.

## Current host/WebView contract

- The first screen accepts typing or pasting an HTTP/HTTPS MultiView host URL. Missing schemes are normalized to `http://` for LAN use.
- Only normalized HTTP/HTTPS origins are accepted. Credentials, query strings, fragments, unsupported schemes, malformed hosts, and invalid ports are rejected with an actionable native error.
- A host is remembered only after a trusted same-origin page (including the existing `/login` page) commits successfully. A normal restart attempts the last successful host; an error state or the change-host action can replace it.
- The WebView shows distinct native states for connecting, unreachable hosts, HTTP errors, TLS/certificate failures, and expired login sessions. Each recoverable state has retry and/or change-host actions, and failed main-frame loads never leave a blank WebView.
- JavaScript, DOM storage, first-party cookies, and media playback are enabled for the existing MultiView web client. Third-party cookies, file access, and content access are disabled.
- The existing Web login page remains responsible for submitting the access key and setting the HttpOnly session cookie. Android does not store or log the access key, session cookie, or full navigated URL.
- Only same-origin HTTP/HTTPS MultiView navigation stays in the trusted WebView. Other web origins open with the system browser; unsupported schemes are blocked. No JavaScript bridge is exposed.
- Replacing the trusted host clears WebView cookies, storage, cache, form data, and history before the new host is loaded, preventing cross-host session reuse.
- WebView file/content access is disabled. The manifest requests only network access; it does not request storage or Eagle-library file permissions.

Android Back integration, file import/download, reconnection recovery, and release signing are intentionally left to their later GitHub tickets.

## Git hygiene

`android/.gitignore` excludes Gradle/IDE build state, APK/AAB outputs, `local.properties`, signing material, and local keystore configuration. Do not commit host addresses, cookies, device credentials, or release signing keys.
