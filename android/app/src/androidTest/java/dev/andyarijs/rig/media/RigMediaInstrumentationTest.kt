package dev.andyarijs.rig.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Executes Android's real decoders and hardware/software MediaCodec exporters.
 * No network, provider key, quote or paid generation is involved. */
@RunWith(AndroidJUnit4::class)
class RigMediaInstrumentationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val preparer = RigMediaPreparer(context)

    @Test fun phonePhotoAppliesExifRotationBeforeCropAndStripsMetadata(): Unit = runBlocking {
        val original = File(context.cacheDir, "orientation-test.jpg")
        val bitmap = Bitmap.createBitmap(1400, 900, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply { drawColor(Color.RED) }
        original.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        ExifInterface(original).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "50/1,0/1,0/1")
            saveAttributes()
        }
        try {
            val source = preparer.inspect(Uri.fromFile(original))
            assertEquals(900, source.width)
            assertEquals(1400, source.height)
            val asset = preparer.prepareImage(source)
            try {
                assertEquals(900, asset.width)
                assertEquals(1400, asset.height)
                assertTrue(asset.file.canonicalPath.startsWith(context.cacheDir.canonicalPath + "/rig-media/"))
                assertTrue(asset.sizeBytes in 1..RigMediaLimits.MAX_ASSET_BYTES)
                val exif = ExifInterface(asset.file)
                assertNull(exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE))
                assertTrue(exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED) in setOf(ExifInterface.ORIENTATION_UNDEFINED, ExifInterface.ORIENTATION_NORMAL))
                BitmapFactory.decodeFile(asset.file.absolutePath).also { assertEquals(900, it.width); assertEquals(1400, it.height); it.recycle() }
            } finally { asset.file.delete() }
        } finally { original.delete() }
    }

    @Test fun selectedFrameIsJpegAndMotionIsActuallyTrimmedCroppedH264Aac(): Unit = runBlocking {
        val sourceFile = fixture()
        try {
            val source = preparer.inspect(Uri.fromFile(sourceFile))
            assertTrue(source.isVideo)
            assertEquals(720, source.width)
            assertEquals(1280, source.height)
            assertTrue(source.durationMs >= 8900)
            val frame = preparer.prepareFrame(source, 5000)
            try { assertEquals("image/jpeg", frame.mimeType); assertNull(frame.durationSeconds); assertNotEquals(sourceFile, frame.file) }
            finally { frame.file.delete() }
            val crop = NormalizedCrop(.25f, .25f, .75f, .75f)
            val motion = preparer.prepareMotion(source, 2000, 5, crop, keepSound = true)
            try {
                assertEquals("video/mp4", motion.mimeType)
                assertEquals(5, motion.durationSeconds)
                assertEquals(360, motion.width)
                assertEquals(640, motion.height)
                assertTrue(motion.hasAudio)
                assertEquals(sha256(motion.file), motion.revision)
                assertTrue(motion.sizeBytes in 1..RigMediaLimits.MAX_ASSET_BYTES)
                val verified = preparer.inspect(Uri.fromFile(motion.file))
                assertTrue(verified.durationMs in 4800..5200)
                assertTrue(verified.hasAudio)
                assertTrue(trackMimes(motion.file).contains("video/avc"))
                assertTrue(trackMimes(motion.file).contains("audio/mp4a-latm"))
                // For local Node inspectMp4 validation after an instrumented run.
                motion.file.copyTo(File(context.cacheDir, "instrumentation-normalized-with-audio.mp4"), overwrite = true)
            } finally { motion.file.delete() }
        } finally { sourceFile.delete() }
    }

    @Test fun smallUsableFaceCropFromLargePhonePhotoRetainsItsSourceDetail(): Unit = runBlocking {
        val original = File(context.cacheDir, "large-phone-photo.jpg")
        val bitmap = Bitmap.createBitmap(6000, 4000, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).drawColor(Color.BLUE)
        original.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        try {
            val source = preparer.inspect(Uri.fromFile(original))
            val photo = preparer.prepareImage(source, NormalizedCrop(.1f, .1f, .16f, .19f))
            try {
                assertEquals(360, photo.width)
                assertEquals(360, photo.height)
                assertTrue(photo.sizeBytes < 1024 * 1024)
            } finally { photo.file.delete() }
        } finally { original.delete() }
    }

    @Test fun minimumDurationAndSoundRemovalMatchServerUploadContract(): Unit = runBlocking {
        val sourceFile = fixture()
        try {
            val source = preparer.inspect(Uri.fromFile(sourceFile))
            val motion = preparer.prepareMotion(source, 1000, 3, keepSound = false)
            try {
                val verified = preparer.inspect(Uri.fromFile(motion.file))
                assertTrue(verified.durationMs in 3080..3370)
                assertFalse(verified.hasAudio)
                assertFalse(trackMimes(motion.file).any { it.startsWith("audio/") })
                motion.file.copyTo(File(context.cacheDir, "instrumentation-normalized-no-audio.mp4"), overwrite = true)
            } finally { motion.file.delete() }
        } finally { sourceFile.delete() }
    }

    @Test fun hugeIkMp4SourceStaysLocalAndOnlyChosenFrameAndSixSecondsArePrepared(): Unit = runBlocking {
        val path = InstrumentationRegistry.getArguments().getString("rigSourceVideoPath")
        assumeTrue("Pass -e rigSourceVideoPath pointing to a device copy of ik.mp4 to run the real large-phone-video check.", path != null)
        val original = File(path!!)
        assertTrue("The test must use the original large input.", original.isFile && original.length() > 400L * 1024 * 1024)
        val before = original.length()
        val source = preparer.inspect(Uri.fromFile(original))
        assertTrue(source.durationMs > 50_000)
        val frame = preparer.prepareFrame(source, 9000)
        try {
            assertEquals("image/jpeg", frame.mimeType)
            assertTrue(frame.sizeBytes < 2L * 1024 * 1024)
            assertTrue(frame.width <= 2048 && frame.height <= 2048)
            assertTrue("The portrait phone rotation must be applied before choosing a frame.", frame.height > frame.width)
            frame.file.copyTo(File(context.cacheDir, "instrumentation-ik-frame.jpg"), overwrite = true)
        } finally { frame.file.delete() }
        val motion = preparer.prepareMotion(source, 8000, 6)
        try {
            assertTrue(motion.sizeBytes < 8L * 1024 * 1024)
            assertNotEquals(original.canonicalPath, motion.file.canonicalPath)
            assertTrue(preparer.inspect(Uri.fromFile(motion.file)).durationMs in 5800..6200)
            assertEquals(before, original.length())
            motion.file.copyTo(File(context.cacheDir, "instrumentation-ik-six-seconds.mp4"), overwrite = true)
        } finally { motion.file.delete() }
    }

    private fun fixture(): File {
        val file = File(context.cacheDir, "source-${System.nanoTime()}.mp4")
        instrumentation.context.assets.open("native-media-fixture.mp4").use { input -> file.outputStream().use { input.copyTo(it) } }
        return file
    }

    private fun trackMimes(file: File): List<String> {
        val extractor = MediaExtractor()
        try { extractor.setDataSource(file.absolutePath); return (0 until extractor.trackCount).map { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME) ?: "" } }
        finally { extractor.release() }
    }
}
