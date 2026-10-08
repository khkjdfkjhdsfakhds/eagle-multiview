package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileChooserCoordinatorTest {
    @Test
    fun `result is delivered once and the next chooser can open`() {
        val coordinator = FileChooserCoordinator<String>()
        val first = Recorder()
        coordinator.begin(first::deliver)

        assertTrue(coordinator.complete(listOf("content://a", "content://b")))
        assertEquals(listOf<List<String>?>(listOf("content://a", "content://b")), first.values)
        assertFalse(coordinator.hasPending)
        assertFalse(coordinator.complete(listOf("content://late")))
        assertEquals(1, first.values.size)

        val second = Recorder()
        coordinator.begin(second::deliver)
        assertTrue(coordinator.hasPending)
    }

    @Test
    fun `cancel and empty results deliver null so the page can reopen the chooser`() {
        val coordinator = FileChooserCoordinator<String>()
        val cancelled = Recorder()
        coordinator.begin(cancelled::deliver)
        assertTrue(coordinator.cancel())
        assertEquals(listOf<List<String>?>(null), cancelled.values)

        val empty = Recorder()
        coordinator.begin(empty::deliver)
        assertTrue(coordinator.complete(emptyList()))
        assertEquals(listOf<List<String>?>(null), empty.values)

        assertFalse(coordinator.cancel())
    }

    @Test
    fun `a newer request cancels the unanswered one first`() {
        val coordinator = FileChooserCoordinator<String>()
        val stale = Recorder()
        val current = Recorder()
        coordinator.begin(stale::deliver)
        coordinator.begin(current::deliver)

        assertEquals(listOf<List<String>?>(null), stale.values)
        coordinator.complete(listOf("content://x"))
        assertEquals(listOf<List<String>?>(listOf("content://x")), current.values)
        assertEquals(1, stale.values.size)
    }

    @Test
    fun `picker results merge clip items and data uri without duplicates`() {
        assertEquals(
            listOf("a", "b", "c"),
            FileChooserResult.collect(true, listOf("a", null, "b", "a"), "c"),
        )
        assertEquals(listOf("single"), FileChooserResult.collect(true, emptyList(), "single"))
        assertEquals(listOf("a"), FileChooserResult.collect(true, listOf("a"), "a"))
        assertNull(FileChooserResult.collect(true, emptyList<String?>(), null))
        assertNull(FileChooserResult.collect(false, listOf("a"), "b"))
    }

    @Test
    fun `accept values map to picker mime filters`() {
        val extensions = mapOf("png" to "image/png", "mp4" to "video/mp4")
        val resolve = { accept: List<String?> -> FileChooserMimeTypes.resolve(accept) { extensions[it] } }

        assertEquals(emptyList<String>(), resolve(emptyList()))
        assertEquals(emptyList<String>(), resolve(listOf("", null)))
        assertEquals(listOf("image/*", "video/*"), resolve(listOf("image/*, video/*")))
        assertEquals(listOf("image/png", "video/mp4"), resolve(listOf(".PNG", ".mp4", "image/png")))
        // Anything the picker cannot express widens to any file instead of hiding accepted files.
        assertEquals(emptyList<String>(), resolve(listOf("image/*", ".unknown")))
        assertEquals(emptyList<String>(), resolve(listOf("image/*", "*/*")))
        assertEquals(emptyList<String>(), resolve(listOf("audio")))
    }

    private class Recorder {
        val values = mutableListOf<List<String>?>()

        fun deliver(value: List<String>?) {
            values += value
        }
    }
}
