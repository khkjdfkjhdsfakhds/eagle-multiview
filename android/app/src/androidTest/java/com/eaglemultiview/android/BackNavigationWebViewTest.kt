package com.eaglemultiview.android

import android.content.Context
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.pressBack
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.hamcrest.CoreMatchers.containsString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BackNavigationWebViewTest {
    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before
    fun setUp() {
        clearSavedHostAndWebData()
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    @After
    fun tearDown() {
        if (::scenario.isInitialized) scenario.close()
    }

    @Test
    fun dispatcherHonorsHandledBlockedAndExitOneStepAtATime() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backContractScript("['handled','blocked','exit']") +
                        "<p id='result'>ready</p><p id='calls'>0</p>",
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")

            dispatchBack()
            assertWebText("calls", "1")
            assertActivityOpen()

            dispatchBack()
            assertWebText("calls", "2")
            assertActivityOpen()

            dispatchBack()
            waitForActivityDestroyed()
        }
    }

    @Test
    fun systemBackInjectionHonorsTrustedHandledContract() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backContractScript("['handled']") +
                        "<p id='result'>ready</p><p id='calls'>0</p>",
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")

            pressBack()

            assertWebText("calls", "1")
            assertActivityOpen()
        }
    }

    @Test
    fun rapidBackPressesDispatchOnlyOneJavascriptRequest() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backContractScript("['handled','handled']") +
                        "<p id='result'>ready</p><p id='calls'>0</p>",
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")

            dispatchBack(times = 2)

            assertWebText("calls", "1")
            assertActivityOpen()
        }
    }

    @Test
    fun invalidJavascriptResultNeverFinishesTrustedActivity() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    """
                    <script>
                    window.calls = 0;
                    window.EagleMVBack = { request() {
                      window.calls += 1;
                      document.getElementById('calls').textContent = String(window.calls);
                      return { status: 'exit' };
                    }};
                    </script>
                    <p id='result'>ready</p><p id='calls'>0</p>
                    """.trimIndent(),
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")

            dispatchBack()

            assertWebText("calls", "1")
            assertActivityOpen()
        }
    }

    @Test
    fun untrustedCommittedPageCannotInvokeBackContractOrExit() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backContractScript("['exit']") +
                        "<p id='result'>trusted</p><p id='calls'>0</p>",
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "trusted")

            scenario.onActivity { activity ->
                activity.findViewById<WebView>(R.id.webView).loadDataWithBaseURL(
                    "https://untrusted.example.test/",
                    """
                    <!doctype html><html><body>
                    <script>
                    window.calls = 0;
                    window.EagleMVBack = { request() {
                      window.calls += 1;
                      document.getElementById('calls').textContent = String(window.calls);
                      return {status:'exit',handled:false,blocked:false,exit:true,action:'host'};
                    }};
                    </script>
                    <p id='result'>untrusted</p><p id='calls'>0</p>
                    </body></html>
                    """.trimIndent(),
                    "text/html",
                    "UTF-8",
                    null,
                )
            }
            assertWebText("result", "untrusted")

            dispatchBack()

            assertWebText("calls", "0")
            assertActivityOpen()
        }
    }

    @Test
    fun loadingPageBackDoesNotBypassWebContract() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse("<p id='result'>late</p>")
                    .setHeadersDelay(3, TimeUnit.SECONDS),
            )
            server.start()
            connect(server.url("/").toString())

            dispatchBack()

            assertActivityOpen()
        }
    }

    @Test
    fun trustedLoginPageUsesTheSameBackContract() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backContractScript("['handled']") +
                        "<p id='result'>login</p><p id='calls'>0</p>",
                ),
            )
            server.start()
            connect(server.url("/login").toString())
            assertWebText("result", "login")
            onView(withId(R.id.authBanner)).check(matches(isDisplayed()))

            dispatchBack()

            assertWebText("calls", "1")
            assertActivityOpen()
        }
    }

    @Test
    fun nativeErrorPageBackStaysOpenForRetry() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503))
            server.start()
            connect(server.url("/").toString())
            onView(withText(R.string.state_http_error_title)).check(matches(isDisplayed()))

            dispatchBack()

            assertActivityOpen()
            onView(withId(R.id.retryButton)).check(matches(isDisplayed()))
        }
    }

    @Test
    fun javascriptTimeoutKeepsActivityOpenAndIgnoresLateExit() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    """
                    <script>
                    window.EagleMVBack = { request() {
                      const deadline = Date.now() + 2200;
                      while (Date.now() < deadline) {}
                      return {status:'exit',handled:false,blocked:false,exit:true,action:'host'};
                    }};
                    </script>
                    <p id='result'>ready</p>
                    """.trimIndent(),
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")

            dispatchBack()
            SystemClock.sleep(3_000)

            assertActivityOpen()
        }
    }

    private fun connect(url: String) {
        onView(withId(R.id.hostInput)).perform(replaceText(url))
        closeSoftKeyboard()
        onView(withId(R.id.connectButton)).perform(click())
    }

    private fun dispatchBack(times: Int = 1) {
        scenario.onActivity { activity ->
            repeat(times) { activity.onBackPressedDispatcher.onBackPressed() }
        }
    }

    private fun assertActivityOpen() {
        assertNotEquals(Lifecycle.State.DESTROYED, scenario.state)
    }

    private fun waitForActivityDestroyed() {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (scenario.state == Lifecycle.State.DESTROYED) return
            SystemClock.sleep(50)
        }
        assertEquals(Lifecycle.State.DESTROYED, scenario.state)
    }

    private fun assertWebText(elementId: String, expected: String) {
        onWebView()
            .withElement(findElement(Locator.ID, elementId))
            .check(webMatches(getText(), containsString(expected)))
    }

    private fun backContractScript(statuses: String): String =
        """
        <script>
        window.backStatuses = $statuses;
        window.backCalls = 0;
        window.EagleMVBack = { request() {
          const status = window.backStatuses[Math.min(window.backCalls, window.backStatuses.length - 1)];
          window.backCalls += 1;
          document.getElementById('calls').textContent = String(window.backCalls);
          return {
            status,
            handled: status === 'handled',
            blocked: status === 'blocked',
            exit: status === 'exit',
            action: status === 'handled' ? 'transient' : status === 'blocked' ? 'preview' : 'host'
          };
        }};
        </script>
        """.trimIndent()

    private fun htmlResponse(body: String): MockResponse = MockResponse()
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .setBody("<!doctype html><html><body>$body</body></html>")

    private fun clearSavedHostAndWebData() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences(
            SharedPreferencesRecentHostStore.PREFERENCES_NAME,
            Context.MODE_PRIVATE,
        ).edit().clear().commit()
        val finished = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies { finished.countDown() }
            CookieManager.getInstance().flush()
        }
        check(finished.await(5, TimeUnit.SECONDS)) { "WebView cookie cleanup timed out" }
    }
}
