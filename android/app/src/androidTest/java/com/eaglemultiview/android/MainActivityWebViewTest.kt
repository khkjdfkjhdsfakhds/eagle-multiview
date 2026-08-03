package com.eaglemultiview.android

import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.ext.junit.rules.ActivityScenarioRule
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.hamcrest.CoreMatchers.containsString
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityWebViewTest {
    @get:Rule
    val activityRule = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun acceptsAHostAndLoadsJavaScriptDomStorageAndCookiesInTheWebView() {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setHeader("Content-Type", "text/html; charset=utf-8").setBody(
                    """
                    <!doctype html>
                    <html>
                      <body>
                        <p id="result">waiting</p>
                        <script>
                          document.cookie = 'multiview_test=ready; SameSite=Lax';
                          localStorage.setItem('multiview_test', 'ready');
                          const ready = document.cookie.includes('multiview_test=ready') &&
                            localStorage.getItem('multiview_test') === 'ready';
                          document.getElementById('result').textContent = ready
                            ? 'Eagle MultiView WebView ready'
                            : 'WebView capability missing';
                        </script>
                      </body>
                    </html>
                    """.trimIndent(),
                ),
            )
            server.start()

            onView(withText(R.string.host_entry_title)).check(matches(isDisplayed()))
            onView(withId(R.id.hostInput)).perform(replaceText(server.url("/").toString()))
            closeSoftKeyboard()
            onView(withId(R.id.connectButton)).perform(click())

            onWebView()
                .withElement(findElement(Locator.ID, "result"))
                .check(webMatches(getText(), containsString("Eagle MultiView WebView ready")))
        }
    }
}
