package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SavedHostBookTest {
    private fun endpoint(raw: String) = (HostUrlValidator.validate(raw) as HostInputResult.Valid).endpoint

    private val home = endpoint("http://192.168.1.20:41600")
    private val office = endpoint("http://10.0.0.5:41600")
    private val tailnet = endpoint("http://100.64.0.7:41600")

    @Test
    fun `connections build a newest-first history without duplicates`() {
        val book = SavedHostBook()
            .recordConnected(home, 1)
            .recordConnected(office, 2)
            .recordConnected(home, 3)

        assertEquals(listOf(home, office), book.entries.map { it.endpoint })
        assertEquals(3L, book.find(home.startUrl)?.lastConnectedAt)
    }

    @Test
    fun `pinned addresses come first in pin order and survive history eviction`() {
        var book = SavedHostBook()
            .recordConnected(home, 1)
            .recordConnected(office, 2)
            .recordConnected(tailnet, 3)
            .pin(office.startUrl, "  公司\t电脑 ", 10)
            .pin(home.startUrl, "", 11)

        assertEquals(listOf(office, home, tailnet), book.entries.map { it.endpoint })
        assertEquals("公司 电脑", book.find(office.startUrl)?.name)
        assertNull("a blank name falls back to the address", book.find(home.startUrl)?.name)
        assertEquals(home.startUrl, book.find(home.startUrl)?.label)

        for (i in 0 until SavedHostBook.MAX_HISTORY + 5) {
            book = book.recordConnected(endpoint("http://host$i.example.test"), 100L + i)
        }
        assertEquals(SavedHostBook.MAX_HISTORY + 2, book.entries.size)
        assertTrue(book.find(office.startUrl)!!.pinned)
        assertTrue(book.find(home.startUrl)!!.pinned)
        assertNull("oldest history is evicted", book.find(tailnet.startUrl))

        val afterUnpin = book.unpin(office.startUrl, 1_000)
        val unpinned = afterUnpin.find(office.startUrl)!!
        assertFalse(unpinned.pinned)
        assertNull(unpinned.name)
        assertEquals("rejoins history as the newest entry", office, afterUnpin.entries[1].endpoint)
    }

    @Test
    fun `pin keeps the original pin position when renaming`() {
        val book = SavedHostBook()
            .recordConnected(home, 1)
            .recordConnected(office, 2)
            .pin(home.startUrl, "家", 5)
            .pin(office.startUrl, "公司", 6)
            .pin(home.startUrl, "家里", 9)

        assertEquals(listOf(home, office), book.entries.map { it.endpoint })
        assertEquals("家里", book.entries.first().name)
    }

    @Test
    fun `suggestions match address or name and show everything for a complete address`() {
        val book = SavedHostBook()
            .recordConnected(home, 1)
            .recordConnected(office, 2)
            .pin(office.startUrl, "公司", 3)

        assertEquals(2, book.suggestions(null).size)
        assertEquals(2, book.suggestions(home.startUrl).size)
        assertEquals(listOf(home), book.suggestions("192.168").map { it.endpoint })
        assertEquals(listOf(office), book.suggestions("公司").map { it.endpoint })
        assertTrue(book.suggestions("nothing").isEmpty())
        assertEquals(listOf(home), book.remove(office.startUrl).entries.map { it.endpoint })
    }

    @Test
    fun `failover tries other origins in list order and skips tried ones`() {
        val sameOriginOtherPath = endpoint("http://192.168.1.20:41600/other/")
        val book = SavedHostBook()
            .recordConnected(home, 1)
            .recordConnected(sameOriginOtherPath, 2)
            .recordConnected(office, 3)
            .recordConnected(tailnet, 4)
            .pin(tailnet.startUrl, null, 5)

        assertEquals(listOf(tailnet, office), book.failoverCandidates(home, setOf(home.startUrl)))
        assertEquals(listOf(office), book.failoverCandidates(home, setOf(home.startUrl, tailnet.startUrl)))
        assertTrue(book.failoverCandidates(home, book.entries.map { it.endpoint.startUrl }.toSet()).isEmpty())
    }

    @Test
    fun `codec round-trips and drops invalid entries`() {
        val book = SavedHostBook()
            .recordConnected(home, 1)
            .recordConnected(office, 2)
            .pin(office.startUrl, "公司", 3)

        val decoded = SavedHostCodec.decode(SavedHostCodec.encode(book))
        assertEquals(book.entries, decoded.entries)

        val mixed = """[{"url":"ftp://bad"},{"url":"http://ok.example.test","pinned":true,"name":null},7]"""
        assertEquals(listOf("http://ok.example.test/"), SavedHostCodec.decode(mixed).entries.map { it.endpoint.startUrl })
        assertTrue(SavedHostCodec.decode("not json").entries.isEmpty())
        assertTrue(SavedHostCodec.decode(null).entries.isEmpty())
    }

    @Test
    fun `site data is kept per origin while addresses are remembered`() {
        // Feature off: unchanged rules — any origin change clears, leaving a host clears.
        assertFalse(SiteDataPolicy.clearBeforeConnecting(null, home.origin, null))
        assertFalse(SiteDataPolicy.clearBeforeConnecting(home.origin, home.origin, null))
        assertTrue(SiteDataPolicy.clearBeforeConnecting(home.origin, office.origin, null))
        assertTrue(SiteDataPolicy.clearOnLeavingHost(home.origin, null))
        assertFalse(SiteDataPolicy.clearOnLeavingHost(null, null))

        // Feature on: origins keep their own data; removal/turn-off clear it instead.
        val saved = setOf(home.origin, office.origin)
        assertFalse(SiteDataPolicy.clearBeforeConnecting(home.origin, office.origin, saved))
        assertFalse(SiteDataPolicy.clearBeforeConnecting(null, office.origin, saved))
        assertFalse("adding a new address keeps the remembered logins", SiteDataPolicy.clearBeforeConnecting(home.origin, tailnet.origin, saved))
        assertFalse(SiteDataPolicy.clearOnLeavingHost(home.origin, saved))
        assertFalse(SiteDataPolicy.clearOnLeavingHost(tailnet.origin, emptySet()))
    }

    @Test
    fun `coordinator applies the remembered-address policy`() {
        var saved: Set<String>? = setOf(home.origin, office.origin)
        val coordinator = HostConnectionCoordinator(object : RecentHostStore {
            override fun read(): HostEndpoint? = null
            override fun save(endpoint: HostEndpoint) = Unit
        }) { saved }

        assertFalse(coordinator.beginConnection(home))
        assertFalse("remembered to remembered keeps the login", coordinator.beginConnection(office))
        assertFalse("a new address does not log out the remembered ones", coordinator.beginConnection(tailnet))
        assertFalse("leaving keeps the logins", coordinator.showHostEntry())

        saved = null
        coordinator.beginConnection(home)
        assertTrue("feature off restores the old rule", coordinator.beginConnection(office))
    }
}
