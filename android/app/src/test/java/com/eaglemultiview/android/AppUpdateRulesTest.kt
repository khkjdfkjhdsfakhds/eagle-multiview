package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateRulesTest {
    private val release = """
        {"tag_name":"v1.9.0","draft":false,"prerelease":false,
         "html_url":"https://github.com/khkjdfkjhdsfakhds/eagle-multiview/releases/tag/v1.9.0",
         "body":"## 新功能\n- **检查更新**：`菜单`\n\n\n\n- [说明](https://x)",
         "assets":[
           {"name":"Eagle-MultiView-1.9.0-arm64.dmg","browser_download_url":"https://dl/a.dmg","size":10},
           {"name":"Eagle-MultiView-1.9.0-android.apk","browser_download_url":"https://dl/a.apk","size":20},
           {"name":"SHA256SUMS.txt","browser_download_url":"https://dl/sums","size":3}
         ]}
    """.trimIndent()

    @Test
    fun comparesVersionsNumerically() {
        assertTrue(AppUpdateRules.compareVersions("1.8.10", "1.8.9") > 0)
        assertTrue(AppUpdateRules.compareVersions("v1.9.0", "1.8.1") > 0)
        assertEquals(0, AppUpdateRules.compareVersions("1.8", "1.8.0"))
        assertTrue(AppUpdateRules.compareVersions("1.8.0", "1.10.0") < 0)
        assertTrue(AppUpdateRules.compareVersions("1.9.0-beta.1", "1.9.0") < 0)
        assertEquals(0, AppUpdateRules.compareVersions("garbage", "1.0.0"))
    }

    @Test
    fun parsesReleaseAndPicksAndroidAssets() {
        val parsed = AppUpdateRules.parseRelease(release)!!
        assertEquals("1.9.0", parsed.version)
        assertEquals("https://dl/a.apk", parsed.apkAsset()!!.url)
        assertEquals(20L, parsed.apkAsset()!!.size)
        assertEquals("https://dl/sums", parsed.checksumAsset()!!.url)
        assertEquals("新功能\n• 检查更新：菜单\n\n• 说明", AppUpdateRules.plainNotes(parsed.notes))
    }

    @Test
    fun rejectsDraftsPrereleasesAndJunk() {
        assertNull(AppUpdateRules.parseRelease(release.replace("\"draft\":false", "\"draft\":true")))
        assertNull(AppUpdateRules.parseRelease(release.replace("\"prerelease\":false", "\"prerelease\":true")))
        assertNull(AppUpdateRules.parseRelease(release.replace("v1.9.0\"", "nightly\"")))
        assertNull(AppUpdateRules.parseRelease("<html>rate limited</html>"))
        assertNull(AppUpdateRules.parseRelease(release.replace("-android.apk", ".zip"))!!.apkAsset())
    }

    @Test
    fun readsChecksumFile() {
        val sums = AppUpdateRules.parseSha256Sums(
            "${"A".repeat(64)}  Eagle-MultiView-1.9.0-android.apk\n${"b".repeat(64)} *dir/x.dmg\nnoise\n",
        )
        assertEquals("a".repeat(64), sums["Eagle-MultiView-1.9.0-android.apk"])
        assertEquals("b".repeat(64), sums["x.dmg"])
        assertEquals(2, sums.size)
    }

    @Test
    fun checksOncePerDay() {
        assertTrue(AppUpdateRules.isDue(0, AppUpdateRules.CHECK_INTERVAL_MS))
        assertFalse(AppUpdateRules.isDue(1_000, AppUpdateRules.CHECK_INTERVAL_MS))
    }
}
