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
- JavaScript, DOM storage, cookies, third-party cookies, and media playback are enabled for the existing MultiView web client.
- WebView file/content access is disabled. The manifest requests only network access; it does not request storage or Eagle-library file permissions.
- The scaffold keeps the entered host only in the running Activity. Saved-host reuse, host trust boundaries, external-link dispatch, login/session recovery, and host switching belong to GitHub Issue #7.

Authentication/session hardening, Android Back integration, file import/download, reconnection recovery, and release signing are intentionally left to their later GitHub tickets.

## Git hygiene

`android/.gitignore` excludes Gradle/IDE build state, APK/AAB outputs, `local.properties`, signing material, and local keystore configuration. Do not commit host addresses, cookies, device credentials, or release signing keys.
