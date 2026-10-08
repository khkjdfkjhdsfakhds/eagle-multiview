package com.eaglemultiview.android

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.SystemClock
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasExtra
import androidx.test.espresso.intent.rule.IntentsRule
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.hamcrest.CoreMatchers.allOf
import org.hamcrest.CoreMatchers.containsString
import org.junit.After
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Keyboard focus, Esc routing, and the file chooser contract of the native shell. */
@RunWith(AndroidJUnit4::class)
class ShellIntegrationWebViewTest {
    @get:Rule
    val intentsRule = IntentsRule()

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
    fun loadedPageOwnsKeyboardFocusAndReceivesKeys() {
        MockWebServer().use { server ->
            server.enqueue(htmlResponse(KEY_LOG_SCRIPT + "<p id='result'>ready</p><p id='keys'></p>"))
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")
            waitForWebViewFocus()

            sendKey(KeyEvent.KEYCODE_A)
            sendKey(KeyEvent.KEYCODE_ENTER)

            assertWebText("keys", "a,Enter")
        }
    }

    @Test
    fun unhandledArrowsAndTabNeverMoveFocusToNativeControls() {
        MockWebServer().use { server ->
            server.enqueue(htmlResponse(KEY_LOG_SCRIPT + "<p id='result'>ready</p><p id='keys'></p>"))
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")
            waitForWebViewFocus()

            listOf(
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_TAB,
            ).forEach(::sendKey)
            sendKey(KeyEvent.KEYCODE_B)

            assertWebText("keys", "ArrowUp,ArrowDown,ArrowLeft,ArrowRight,Tab,b")
            assertTrue(webViewHasFocus())
        }
    }

    @Test
    fun unhandledEscRequestsWebBackExactlyOnce() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backCounterScript() + "<p id='result'>ready</p><p id='calls'>0</p>",
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")
            waitForWebViewFocus()

            sendKey(KeyEvent.KEYCODE_ESCAPE)

            assertWebText("calls", "1")
            SystemClock.sleep(500)
            assertWebText("calls", "1")
            assertNotEquals(Lifecycle.State.DESTROYED, scenario.state)
        }
    }

    @Test
    fun escConsumedByThePageDoesNotAlsoRequestBack() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backCounterScript() +
                        """
                        <script>
                        document.addEventListener('keydown', event => {
                          if (event.key !== 'Escape') return;
                          event.preventDefault();
                          document.getElementById('closed').textContent = 'closed';
                        });
                        </script>
                        <p id='result'>ready</p><p id='calls'>0</p><p id='closed'></p>
                        """.trimIndent(),
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")
            waitForWebViewFocus()

            sendKey(KeyEvent.KEYCODE_ESCAPE)

            assertWebText("closed", "closed")
            SystemClock.sleep(500)
            assertWebText("calls", "0")
        }
    }

    @Test
    fun keyboardEscRemappedToBackReachesThePageAsEsc() {
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    backCounterScript() +
                        """
                        <script>
                        const codes = [];
                        document.addEventListener('keydown', event => {
                          codes.push(event.key + '/' + event.code);
                          document.getElementById('keys').textContent = codes.join(',');
                          if (codes.length === 1) event.preventDefault();
                        });
                        </script>
                        <p id='result'>ready</p><p id='calls'>0</p><p id='keys'></p>
                        """.trimIndent(),
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")
            waitForWebViewFocus()

            // First press: the page consumes Esc, so no Back request follows.
            sendRemappedEsc()
            assertWebText("keys", "Escape/Escape")
            SystemClock.sleep(500)
            assertWebText("calls", "0")

            // Second press: left unconsumed, it becomes exactly one Back request.
            sendRemappedEsc()
            assertWebText("keys", "Escape/Escape,Escape/Escape")
            assertWebText("calls", "1")
            SystemClock.sleep(500)
            assertWebText("calls", "1")

            // A plain Back (button or gesture, no scan code) never reaches the page as a key.
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            assertWebText("calls", "2")
            assertWebText("keys", "Escape/Escape,Escape/Escape")
        }
    }

    @Test
    fun cancelledFileChooserCanBeOpenedAgain() {
        intending(hasAction(Intent.ACTION_GET_CONTENT))
            .respondWith(Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null))
        MockWebServer().use { server ->
            server.enqueue(
                htmlResponse(
                    """
                    <input id='picker' type='file' multiple
                      style='position:fixed;left:0;top:0;width:100vw;height:100vh;opacity:0'>
                    <p id='result'>ready</p><p id='events'>0</p>
                    <script>
                    let events = 0;
                    const picker = document.getElementById('picker');
                    const record = () => {
                      events += 1;
                      document.getElementById('events').textContent = String(events);
                    };
                    picker.addEventListener('cancel', record);
                    picker.addEventListener('change', record);
                    </script>
                    """.trimIndent(),
                ),
            )
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")

            onView(withId(R.id.webView)).perform(click())
            assertWebText("events", "1")
            onView(withId(R.id.webView)).perform(click())
            assertWebText("events", "2")

            intended(
                allOf(hasAction(Intent.ACTION_GET_CONTENT), hasExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)),
                androidx.test.espresso.intent.VerificationModes.times(2),
            )
        }
    }

    @Test
    fun rotationKeepsTheLoadedPageInsteadOfReloading() {
        MockWebServer().use { server ->
            val pageLoads = AtomicInteger()
            server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                    if (request.path == "/") pageLoads.incrementAndGet()
                    return htmlResponse(
                        "<p id='result'>ready</p><p id='state'>fresh</p>" +
                            "<script>addEventListener('resize', () => " +
                            "document.getElementById('state').textContent = 'kept ' + innerWidth);</script>",
                    )
                }
            }
            server.start()
            connect(server.url("/").toString())
            assertWebText("result", "ready")
            val activityBefore = AtomicInteger()
            scenario.onActivity { activityBefore.set(System.identityHashCode(it)) }

            try {
                listOf(
                    ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                ).forEach { orientation ->
                    scenario.onActivity { it.requestedOrientation = orientation }
                    SystemClock.sleep(1_500)
                }
                assertWebText("state", "kept")
                scenario.onActivity { activity ->
                    assertTrue(System.identityHashCode(activity) == activityBefore.get())
                }
                assertTrue("page reloaded ${pageLoads.get()} times", pageLoads.get() == 1)
            } finally {
                scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
            }
        }
    }

    private fun connect(url: String) {
        onView(withId(R.id.hostInput)).perform(replaceText(url))
        closeSoftKeyboard()
        onView(withId(R.id.connectButton)).perform(click())
    }

    private fun sendKey(keyCode: Int) {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(keyCode)
    }

    /** What HyperOS delivers for a keyboard Esc: KEYCODE_BACK carrying the Linux KEY_ESC scan code. */
    private fun sendRemappedEsc() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val down = SystemClock.uptimeMillis()
        for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            instrumentation.sendKeySync(
                KeyEvent(
                    down, SystemClock.uptimeMillis(), action, KeyEvent.KEYCODE_BACK, 0, 0,
                    1, RemappedEscapePolicy.SCAN_CODE_ESC, 0, android.view.InputDevice.SOURCE_KEYBOARD,
                ),
            )
        }
    }

    private fun webViewHasFocus(): Boolean {
        val focused = AtomicBoolean(false)
        scenario.onActivity { activity ->
            focused.set(activity.findViewById<WebView>(R.id.webView).hasFocus())
        }
        return focused.get()
    }

    private fun waitForWebViewFocus() {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (webViewHasFocus()) return
            SystemClock.sleep(50)
        }
        assertTrue("WebView never received keyboard focus", webViewHasFocus())
    }

    private fun assertWebText(elementId: String, expected: String) {
        onWebView()
            .withElement(findElement(Locator.ID, elementId))
            .check(webMatches(getText(), containsString(expected)))
    }

    private fun backCounterScript(): String =
        """
        <script>
        window.backCalls = 0;
        window.EagleMVBack = { request() {
          window.backCalls += 1;
          document.getElementById('calls').textContent = String(window.backCalls);
          return {status:'handled',handled:true,blocked:false,exit:false,action:'history'};
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

    private companion object {
        val KEY_LOG_SCRIPT =
            """
            <script>
            const keys = [];
            document.addEventListener('keydown', event => {
              keys.push(event.key);
              document.getElementById('keys').textContent = keys.join(',');
            });
            </script>
            """.trimIndent()
    }
}
