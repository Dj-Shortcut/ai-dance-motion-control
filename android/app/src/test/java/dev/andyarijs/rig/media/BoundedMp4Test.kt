package dev.andyarijs.rig.media

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.ByteBuffer

class BoundedMp4Test {
    @Test fun extendedMdatBecomesBoundedWithoutMovingOneSample() {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.writeInt(16); out.writeBytes("ftyp"); out.writeBytes("isom0000")
            out.writeInt(12); out.writeBytes("moov"); out.writeInt(48) // sample offset sentinel
            out.writeInt(1); out.writeBytes("mdat"); out.writeLong(24); out.writeLong(0x1020304050607080L)
        }
        val file = File.createTempFile("rig-mp4-", ".mp4")
        try {
            val original = bytes.toByteArray()
            file.writeBytes(original)
            normalizeBoundedMp4(file)
            val fixed = file.readBytes()
            assertEquals(original.size, fixed.size)
            assertArrayEquals(original.copyOfRange(0, 28), fixed.copyOfRange(0, 28))
            assertArrayEquals(original.copyOfRange(44, 52), fixed.copyOfRange(44, 52))
            assertEquals(8, ByteBuffer.wrap(fixed, 28, 4).int)
            assertEquals("free", String(fixed, 32, 4, Charsets.US_ASCII))
            assertEquals(16, ByteBuffer.wrap(fixed, 36, 4).int)
            assertEquals("mdat", String(fixed, 40, 4, Charsets.US_ASCII))
            normalizeBoundedMp4(file)
            assertArrayEquals(fixed, file.readBytes())
        } finally { file.delete() }
    }

    @Test fun impossibleBoxLengthCannotReachOutsideBoundedFile() {
        val file = File.createTempFile("rig-mp4-", ".mp4")
        try {
            file.outputStream().use { stream -> DataOutputStream(stream).apply { writeInt(1); writeBytes("mdat"); writeLong(Long.MAX_VALUE); writeLong(0) } }
            try { normalizeBoundedMp4(file); fail("Invalid MP4 must be rejected") } catch (_: IllegalArgumentException) { }
        } finally { file.delete() }
    }
}
