package com.eaglemultiview.android

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.UiController
import androidx.test.espresso.ViewAction
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.espresso.intent.matcher.IntentMatchers.hasData
import androidx.test.espresso.intent.Intents.intended
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.anyIntent
import androidx.test.espresso.intent.rule.IntentsRule
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.DriverAtoms.webKeys
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.hamcrest.CoreMatchers.containsString
import org.hamcrest.CoreMatchers.allOf
import org.hamcrest.CoreMatchers.not
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class MainActivityWebViewTest {
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
    fun firstConnectionSavesHostAndNormalRestartReusesIt() {
        MockWebServer().use { server ->
            server.enqueue(htmlResponse("<p id='result'>first connection</p>"))
            server.enqueue(htmlResponse("<p id='result'>restored connection</p>"))
            server.start()

            connect(server.url("/").toString())
            assertWebText("first connection")

            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            assertWebText("restored connection")
            onView(withId(R.id.hostPanel)).check(matches(not(isDisplayed())))
            onView(withId(R.id.authBanner)).check(matches(not(isDisplayed())))
        }
    }

    @Test
    fun invalidHostShowsUnderstandableNativeError() {
        connect("ftp://example.test")

        onView(withId(R.id.hostErrorText)).check(matches(isDisplayed()))
        onView(withText(R.string.invalid_host_scheme)).check(matches(isDisplayed()))
        onView(withId(R.id.browserContainer)).check(matches(not(isDisplayed())))
    }

    @Test
    fun httpFailureShowsRetryStateAndRetryLoadsPage() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503))
            server.enqueue(htmlResponse("<p id='result'>retry succeeded</p>"))
            server.start()

            connect(server.url("/").toString())
            onView(withText(R.string.state_http_error_title)).check(matches(isDisplayed()))
            onView(withId(R.id.retryButton)).perform(click())
            assertWebText("retry succeeded")
        }
    }

    @Test
    fun loginCookieSurvivesAndInvalidatedSessionReturnsToLoginState() {
        MockWebServer().use { server ->
            val dispatcher = LoginDispatcher()
            server.dispatcher = dispatcher
            server.start()

            connect(server.url("/").toString())
            onView(withId(R.id.authBanner)).check(matches(isDisplayed()))
            onWebView()
                .withElement(findElement(Locator.ID, "key"))
                .perform(webKeys("test-key"))
            onWebView()
                .withElement(findElement(Locator.ID, "login"))
                .perform(webClick())
            waitForStatus(R.string.connected_host)
            assertWebText("authenticated")

            dispatcher.revoked = true
            onWebView()
                .withElement(findElement(Locator.ID, "reload"))
                .perform(webClick())
            waitForDisplayed(R.id.authBanner)

            dispatcher.revoked = false
            onView(withId(R.id.authRetryButton)).perform(click())
            waitForStatus(R.string.connected_host)
            assertWebText("authenticated")

            dispatcher.sawSessionCookie = false
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            waitForStatus(R.string.connected_host)
            assertWebText("authenticated")
            assertTrue(dispatcher.sawSessionCookie)
        }
    }

    @Test
    fun externalLinkLeavesTrustedWebViewForSystemBrowser() {
        MockWebServer().use { server ->
            MockWebServer().use { externalServer ->
                externalServer.start()
                server.enqueue(
                    htmlResponse(
                        "<p id='result'>external page</p><a id='external' href='${externalServer.url("/")}'>external</a>",
                    ),
                )
                server.start()

                connect(server.url("/").toString())
                assertWebText("external page")
                intending(anyIntent()).respondWith(android.app.Instrumentation.ActivityResult(0, Intent()))
                onWebView()
                    .withElement(findElement(Locator.ID, "external"))
                    .perform(webClick())
                intended(
                    allOf(
                        hasAction(Intent.ACTION_VIEW),
                        hasData(externalServer.url("/").toString()),
                    ),
                )
            }
        }
    }

    @Test
    fun changingHostClearsCookiesBeforeTheReplacementLoads() {
        MockWebServer().use { firstServer ->
            MockWebServer().use { secondServer ->
                val replacementCookie = AtomicReference<String?>()
                firstServer.enqueue(htmlResponse("<p id='result'>first host</p>"))
                secondServer.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        replacementCookie.set(request.getHeader("Cookie"))
                        return htmlResponse("<p id='result'>replacement host</p>")
                    }
                }
                firstServer.start()
                secondServer.start()

                connect(firstServer.url("/").toString())
                assertWebText("first host")
                setTestCookie(firstServer.url("/").toString(), "old_host_session=private")

                scenario.onActivity { activity ->
                    activity.findViewById<Button>(R.id.changeHostButton).performClick()
                }
                onView(withId(R.id.hostPanel)).check(matches(isDisplayed()))
                waitForEnabled(R.id.connectButton)
                connect(secondServer.url("/").toString())
                assertWebText("replacement host")

                assertFalse(replacementCookie.get().orEmpty().contains("old_host_session"))
            }
        }
    }

    @Test
    fun staleClientCallbacksCannotOverwriteTheReplacementHostState() {
        MockWebServer().use { firstServer ->
            MockWebServer().use { secondServer ->
                firstServer.enqueue(htmlResponse("<p id='result'>first host</p>"))
                secondServer.enqueue(htmlResponse("<p id='result'>replacement host</p>"))
                firstServer.start()
                secondServer.start()

                connect(firstServer.url("/").toString())
                assertWebText("first host")

                val staleClient = AtomicReference<WebViewClient>()
                scenario.onActivity { activity ->
                    staleClient.set(activity.findViewById<WebView>(R.id.webView).webViewClient)
                    activity.findViewById<Button>(R.id.changeHostButton).performClick()
                }
                waitForDisplayed(R.id.hostPanel)
                waitForEnabled(R.id.connectButton)
                connect(secondServer.url("/").toString())
                assertWebText("replacement host")

                scenario.onActivity { activity ->
                    val currentView = activity.findViewById<WebView>(R.id.webView)
                    val staleUrl = firstServer.url("/stale").toString()
                    staleClient.get().onPageStarted(currentView, staleUrl, null)
                    staleClient.get().onPageCommitVisible(currentView, staleUrl)
                }

                onView(withId(R.id.statusText)).check(matches(withText(R.string.connected_host)))
                assertWebText("replacement host")
            }
        }
    }

    private fun connect(host: String) {
        onView(withId(R.id.hostInput)).perform(replaceText(host))
        closeSoftKeyboard()
        onView(withId(R.id.connectButton)).perform(click())
    }

    private fun assertWebText(text: String) {
        onWebView()
            .reset()
            .withElement(findElement(Locator.ID, "result"))
            .check(webMatches(getText(), containsString(text)))
    }

    private fun waitForStatus(expectedResId: Int) {
        val expected = ApplicationProvider.getApplicationContext<Context>().getString(expectedResId)
        onView(withId(R.id.statusText)).perform(object : ViewAction {
            override fun getConstraints() = isAssignableFrom(TextView::class.java)

            override fun getDescription() = "wait for status text $expected"

            override fun perform(uiController: UiController, view: View) {
                val deadline = SystemClock.uptimeMillis() + 5_000
                do {
                    if ((view as TextView).text.toString() == expected) return
                    uiController.loopMainThreadForAtLeast(50)
                } while (SystemClock.uptimeMillis() < deadline)
                throw AssertionError("Timed out waiting for status text $expected")
            }
        })
    }

    private fun waitForDisplayed(viewId: Int) {
        onView(withId(viewId)).perform(object : ViewAction {
            override fun getConstraints() = isAssignableFrom(View::class.java)

            override fun getDescription() = "wait for view $viewId to be displayed"

            override fun perform(uiController: UiController, view: View) {
                val deadline = SystemClock.uptimeMillis() + 5_000
                do {
                    if (view.isShown && view.width > 0 && view.height > 0) return
                    uiController.loopMainThreadForAtLeast(50)
                } while (SystemClock.uptimeMillis() < deadline)
                throw AssertionError("Timed out waiting for view $viewId to be displayed")
            }
        })
    }

    private fun waitForEnabled(viewId: Int) {
        onView(withId(viewId)).perform(object : ViewAction {
            override fun getConstraints() = isAssignableFrom(View::class.java)

            override fun getDescription() = "wait for view $viewId to be enabled"

            override fun perform(uiController: UiController, view: View) {
                val deadline = SystemClock.uptimeMillis() + 5_000
                do {
                    if (view.isEnabled) return
                    uiController.loopMainThreadForAtLeast(50)
                } while (SystemClock.uptimeMillis() < deadline)
                throw AssertionError("Timed out waiting for view $viewId to be enabled")
            }
        })
    }

    private fun setTestCookie(url: String, cookie: String) {
        val finished = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            CookieManager.getInstance().setCookie(url, cookie) { finished.countDown() }
            CookieManager.getInstance().flush()
        }
        check(finished.await(5, TimeUnit.SECONDS)) { "WebView test cookie setup timed out" }
    }

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

    private inner class LoginDispatcher : Dispatcher() {
        var revoked = false
        var sawSessionCookie = false

        override fun dispatch(request: RecordedRequest): MockResponse {
            return when {
                request.path == "/" -> {
                    val cookie = request.getHeader("Cookie").orEmpty()
                    if (!revoked && cookie.contains("eaglemv_session=valid")) {
                        sawSessionCookie = true
                        htmlResponse("<p id='result'>authenticated</p><a id='reload' href='/'>reload</a>")
                    } else {
                        MockResponse().setResponseCode(302).setHeader("Location", "/login")
                    }
                }
                request.path == "/login" && request.method == "GET" -> htmlResponse(
                    """
                    <input id='key' />
                    <button id='login' onclick="fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('key').value})}).then(r=>{if(r.ok)location.href='/'})">login</button>
                    <p id='result'>login required</p>
                    """.trimIndent(),
                )
                request.path == "/login" && request.method == "POST" -> MockResponse()
                    .setHeader("Content-Type", "application/json")
                    .setHeader("Set-Cookie", "eaglemv_session=valid; HttpOnly; Path=/; Max-Age=3600")
                    .setBody("{\"ok\":true}")
                else -> MockResponse().setResponseCode(404)
            }
        }
    }
}
