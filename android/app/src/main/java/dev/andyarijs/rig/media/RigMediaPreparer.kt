@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package dev.andyarijs.rig.media

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.Crop
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Codec
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Local-only decoding/export. This class has no networking and never reads a source into memory. */
class RigMediaPreparer(context: Context) {
    private val app = context.applicationContext
    private val resolver = app.contentResolver
    private val directory = File(app.cacheDir, "rig-media").apply { check(mkdirs() || isDirectory) }

    /** Call after Photo Picker/OpenDocument. No broad storage permissions are required. */
    fun retainReadPermission(uri: Uri) {
        if (uri.scheme == "content") runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    suspend fun inspect(uri: Uri): NativeMediaSource = withContext(Dispatchers.IO) {
        require(uri.scheme == "content" || uri.scheme == "file") { "Kies een foto of video op je apparaat." }
        val mime = resolver.getType(uri)?.substringBefore(';')?.lowercase()
            ?: inferLocalMime(uri)
        val details = displayDetails(uri)
        when {
            mime.startsWith("video/") -> inspectVideo(uri, details.first, mime, details.second)
            mime in IMAGE_MIMES -> {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                val input = resolver.openInputStream(uri) ?: throw IOException("Deze foto kon niet worden geopend.")
                input.use { BitmapFactory.decodeStream(it, null, bounds) }
                // ImageDecoder can inspect HEIC/AVIF on newer devices even when
                // the older bounds decoder doesn't recognize that format.
                var width = bounds.outWidth
                var height = bounds.outHeight
                if ((width <= 0 || height <= 0) && Build.VERSION.SDK_INT >= 28) {
                    var dimensions: Pair<Int, Int>? = null
                    val tiny = ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                        dimensions = info.size.width to info.size.height
                        decoder.setTargetSize(1, 1)
                        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    }
                    tiny.recycle()
                    val size = dimensions ?: throw IOException("Deze foto kan niet worden gelezen.")
                    width = size.first; height = size.second
                    // ImageInfo dimensions already reflect the decoder's EXIF transform.
                    return@withContext NativeMediaSource(uri, NativeMediaKind.IMAGE, details.first, mime, details.second, width, height)
                }
                require(width > 0 && height > 0) { "Deze foto kan niet worden gelezen op dit apparaat." }
                val orientation = imageOrientation(uri)
                if (orientation in ROTATED_EXIF) { val old = width; width = height; height = old }
                NativeMediaSource(uri, NativeMediaKind.IMAGE, details.first, mime, details.second, width, height)
            }
            else -> throw IOException("Kies een foto (JPG, PNG, WebP of HEIC) of een video.")
        }
    }

    suspend fun prepareImage(source: NativeMediaSource, crop: NormalizedCrop = NormalizedCrop.FULL): PreparedAsset = withContext(Dispatchers.IO) {
        require(!source.isVideo) { "Kies eerst een moment uit je video." }
        val size = RigMediaLimits.imageDimensions(source.width, source.height, crop)
        coroutineContext.ensureActive()
        // Crop as part of decoding: downscaling the entire 48 MP source first
        // would throw away detail from a perfectly usable small face selection.
        val croppedDecode = Build.VERSION.SDK_INT >= 28
        val bitmap = decodeImage(source.uri, if (croppedDecode) crop else null)
        try { writeJpeg(bitmap, if (croppedDecode) NormalizedCrop.FULL else crop, size) } finally { bitmap.recycle() }
    }

    /** Decode only a selected frame, even when the source is a multi-gigabyte 4K video. */
    suspend fun prepareFrame(source: NativeMediaSource, positionMs: Long, crop: NormalizedCrop = NormalizedCrop.FULL): PreparedAsset = withContext(Dispatchers.IO) {
        require(source.isVideo && positionMs >= 0 && positionMs < source.durationMs) { "Kies een moment binnen de video." }
        val size = RigMediaLimits.imageDimensions(source.width, source.height, crop)
        coroutineContext.ensureActive()
        val bitmap = readFrameBitmap(source, positionMs, crop)
        try { coroutineContext.ensureActive(); writeJpeg(bitmap, crop, size) } finally { bitmap.recycle() }
    }

    /** Bounded upright preview for the native crop UI; caller owns/recycles it. */
    suspend fun previewBitmap(source: NativeMediaSource, positionMs: Long = 0): Bitmap = withContext(Dispatchers.IO) {
        coroutineContext.ensureActive()
        val bitmap = if (source.isVideo) readFrameBitmap(source, positionMs.coerceIn(0, source.durationMs - 1)) else decodeImage(source.uri)
        val scale = min(1.0, 1280.0 / max(bitmap.width, bitmap.height))
        if (scale == 1.0) bitmap else Bitmap.createScaledBitmap(bitmap, max(1, (bitmap.width * scale).roundToInt()), max(1, (bitmap.height * scale).roundToInt()), true).also { if (it !== bitmap) bitmap.recycle() }
    }

    /** Decode the selected upright crop in memory. The caller runs on IO and owns the result. */
    internal fun photoCheckBitmap(source: NativeMediaSource, frameMs: Long, crop: NormalizedCrop): Bitmap {
        val croppedInDecoder = !source.isVideo && Build.VERSION.SDK_INT >= 28
        val bitmap = if (source.isVideo) {
            require(frameMs in 0 until source.durationMs) { "Kies een moment binnen de video." }
            // Bound the entire frame before extracting a small area from a large movie.
            readFrameBitmap(source, frameMs)
        } else decodeImage(source.uri, if (croppedInDecoder) crop else null, PHOTO_CHECK_SIDE)
        try {
            val selection = if (croppedInDecoder) NormalizedCrop.FULL else crop
            val rect = RigMediaLimits.pixelCrop(bitmap.width, bitmap.height, selection)
            val scale = min(1.0, PHOTO_CHECK_SIDE.toDouble() / max(rect[2], rect[3]))
            val size = max(1, (rect[2] * scale).roundToInt()) to max(1, (rect[3] * scale).roundToInt())
            return renderImage(bitmap, rect, size)
        } finally { bitmap.recycle() }
    }

    /** A native H264/AAC export; only this bounded short derivative can be uploaded. */
    suspend fun prepareMotion(
        source: NativeMediaSource,
        startMs: Long,
        durationSeconds: Int,
        crop: NormalizedCrop = NormalizedCrop.FULL,
        keepSound: Boolean = true,
        minSide: Int = 0,
        maxDurationSeconds: Int = 30,
        onProgress: (Int?) -> Unit = {}
    ): PreparedAsset {
        require(source.isVideo) { "Kies een bewegingsvideo." }
        val plan = RigMediaLimits.videoPlan(source.width, source.height, source.durationMs, startMs, durationSeconds, crop, minSide, maxDurationSeconds)
        require(source.frameRate == null || source.frameRate >= 20) { "Deze video heeft te weinig beelden per seconde. Kies een video van minstens 20 fps." }
        val output = File(directory, "${UUID.randomUUID()}.mp4")
        try {
            withTimeout(10 * 60_000L) {
                withContext(Dispatchers.Main.immediate) { export(source, plan, crop, keepSound, output, onProgress) }
            }
            return withContext(Dispatchers.IO) {
                coroutineContext.ensureActive()
                normalizeBoundedMp4(output)
                val verified = verifyVideo(output, plan, keepSound && source.hasAudio)
                seal(output, "video/mp4", verified.first, verified.second, durationSeconds, keepSound && source.hasAudio)
            }
        } finally { if (output.exists()) output.delete() }
    }

    /** Delete abandoned derivatives, never original selected photos/videos. */
    fun pruneCache(olderThanMs: Long = 24 * 60 * 60_000L, keep: Set<File> = emptySet()) {
        val deadline = System.currentTimeMillis() - olderThanMs
        directory.listFiles()?.filter { it.isFile && it.lastModified() < deadline && it !in keep }?.forEach { it.delete() }
    }

    private suspend fun export(source: NativeMediaSource, plan: NativeVideoPlan, crop: NormalizedCrop, keepSound: Boolean, output: File, onProgress: (Int?) -> Unit) = suspendCancellableCoroutine<Unit> { continuation ->
        val handler = Handler(Looper.getMainLooper())
        val item = MediaItem.Builder().setUri(source.uri).setClippingConfiguration(MediaItem.ClippingConfiguration.Builder()
            .setStartPositionMs(plan.startMs).setEndPositionMs(plan.startMs + plan.exportDurationMs).build()).build()
        val effects = mutableListOf<Effect>()
        if (crop != NormalizedCrop.FULL) effects += Crop(crop.left * 2 - 1, crop.right * 2 - 1, 1 - crop.bottom * 2, 1 - crop.top * 2)
        effects += Presentation.createForWidthAndHeight(plan.width, plan.height, Presentation.LAYOUT_SCALE_TO_FIT)
        val edited = EditedMediaItem.Builder(item).setFrameRate(30).setRemoveAudio(!keepSound)
            .setEffects(Effects(emptyList(), effects)).build()
        val trackTypes = if (keepSound && source.hasAudio) setOf(C.TRACK_TYPE_VIDEO, C.TRACK_TYPE_AUDIO) else setOf(C.TRACK_TYPE_VIDEO)
        val composition = Composition.Builder(EditedMediaItemSequence.Builder(trackTypes).addItem(edited).build())
            .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL).build()
        val codecs = DefaultEncoderFactory.Builder(app)
            .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(3_000_000).build())
            .setEnableFallback(false).build()
        // Do not remux a huge source or retain pre-trim GOPs via MP4 edit lists.
        val encoder = object : Codec.EncoderFactory by codecs {
            override fun videoNeedsEncoding() = true
            override fun audioNeedsEncoding() = true
        }
        lateinit var transformer: Transformer
        var lastProgress: Int? = null
        val poll = object : Runnable {
            override fun run() {
                if (!continuation.isActive) return
                val holder = ProgressHolder()
                val value = if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) holder.progress.coerceIn(0, 99) else null
                if (value != lastProgress) { lastProgress = value; onProgress(value) }
                handler.postDelayed(this, 250)
            }
        }
        transformer = Transformer.Builder(app).setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoder).setLooper(Looper.getMainLooper())
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                    handler.removeCallbacks(poll)
                    if (continuation.isActive) continuation.resume(Unit)
                }
                override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                    handler.removeCallbacks(poll)
                    if (continuation.isActive) continuation.resumeWithException(IOException("Je apparaat kon dit fragment niet voorbereiden. Er is niets naar Fal gestuurd. Kies een andere video of uitsnede.", exportException))
                }
            }).build()
        continuation.invokeOnCancellation {
            handler.post { handler.removeCallbacks(poll); transformer.cancel(); output.delete() }
        }
        try {
            onProgress(null)
            transformer.start(composition, output.absolutePath)
            handler.post(poll)
        } catch (error: Exception) {
            handler.removeCallbacks(poll)
            transformer.cancel()
            if (continuation.isActive) continuation.resumeWithException(IOException("Dit videofragment kon niet worden voorbereid. Er is geen video gestart.", error))
        }
    }

    private fun verifyVideo(file: File, plan: NativeVideoPlan, requireAudio: Boolean): Pair<Int, Int> {
        require(file.length() in 1..RigMediaLimits.MAX_ASSET_BYTES) { "Het gekozen fragment is te groot na voorbereiding. Kies een korter fragment." }
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            val formats = (0 until extractor.trackCount).map { extractor.getTrackFormat(it) }
            val video = formats.filter { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
            val audio = formats.filter { it.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
            require(video.size == 1 && video.single().getString(MediaFormat.KEY_MIME) == MimeTypes.VIDEO_H264 && audio.size <= 1) { "Je apparaat heeft geen geschikte MP4 gemaakt." }
            require(audio.all { it.getString(MediaFormat.KEY_MIME) == MimeTypes.AUDIO_AAC } && (!requireAudio || audio.size == 1)) { "Het geluid kon niet correct worden voorbereid." }
            require(requireAudio || audio.isEmpty()) { "Het geluid kon niet worden verwijderd." }
            val format = video.single()
            var width = format.getInteger(MediaFormat.KEY_WIDTH)
            var height = format.getInteger(MediaFormat.KEY_HEIGHT)
            require(width in 340..1280 && height in 340..1280) { "Je apparaat heeft een ongeschikt videoformaat gemaakt." }
            val durationMs = format.getLong(MediaFormat.KEY_DURATION) / 1000
            require(abs(durationMs - plan.exportDurationMs) <= 250 && durationMs >= 3_080) { "De duur van het voorbereide fragment klopt niet. Er is geen video gestart." }
            val videoIndex = formats.indexOf(format)
            extractor.selectTrack(videoIndex)
            var samples = 0
            while (extractor.sampleTime >= 0) {
                samples++
                require(samples <= 1800) { "Het fragment bevat te veel videobeelden." }
                if (!extractor.advance()) break
            }
            val fps = samples * 1000.0 / durationMs
            require(fps in 19.9..30.2) { "Het fragment heeft geen geschikte beeldsnelheid." }
            // Media3 may encode portrait frames as landscape with an MP4
            // rotation matrix to match the device encoder's capabilities.
            val rotation = if (format.containsKey(MediaFormat.KEY_ROTATION)) format.getInteger(MediaFormat.KEY_ROTATION) else 0
            if (rotation == 90 || rotation == 270) { val original = width; width = height; height = original }
            return width to height
        } finally { extractor.release() }
    }

    private fun inspectVideo(uri: Uri, name: String, mime: String, bytes: Long?): NativeMediaSource {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(app, uri)
            var width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            var height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (rotation == 90 || rotation == 270) { val original = width; width = height; height = original }
            val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
            require(width > 0 && height > 0 && duration > 0) { "Deze video kan niet worden gelezen op dit apparaat." }
            val audio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
            val fps = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toFloatOrNull()?.takeIf { it.isFinite() && it > 0 }
            return NativeMediaSource(uri, NativeMediaKind.VIDEO, name, mime, bytes, width, height, duration, audio, rotation, fps)
        } finally { retriever.release() }
    }

    private fun readFrameBitmap(source: NativeMediaSource, positionMs: Long, crop: NormalizedCrop = NormalizedCrop.FULL): Bitmap {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(app, source.uri)
            val selected = RigMediaLimits.pixelCrop(source.width, source.height, crop)
            val scale = min(1.0, RigMediaLimits.MAX_IMAGE_SIDE.toDouble() / max(selected[2], selected[3]))
            val frame = if (Build.VERSION.SDK_INT >= 27) {
                retriever.getScaledFrameAtTime(positionMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST, max(1, (source.width * scale).roundToInt()), max(1, (source.height * scale).roundToInt()))
            } else retriever.getFrameAtTime(positionMs * 1000, MediaMetadataRetriever.OPTION_CLOSEST)
            return frame ?: throw IOException("Dit videomoment kon niet worden geopend. Kies een ander moment.")
        } finally { retriever.release() }
    }

    private fun decodeImage(uri: Uri, crop: NormalizedCrop? = null, cropMaxSide: Int = RigMediaLimits.MAX_IMAGE_SIDE): Bitmap {
        if (Build.VERSION.SDK_INT >= 28) {
            val source = if (uri.scheme == "file") ImageDecoder.createSource(File(requireNotNull(uri.path)))
                else ImageDecoder.createSource(resolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val rect = crop?.let { RigMediaLimits.pixelCrop(info.size.width, info.size.height, it) }
                val scale = if (rect == null) min(1.0, 4096.0 / max(info.size.width, info.size.height))
                    else min(1.0, cropMaxSide.toDouble() / max(rect[2], rect[3]))
                val width = max(1, (info.size.width * scale).roundToInt())
                val height = max(1, (info.size.height * scale).roundToInt())
                decoder.setTargetSize(width, height)
                crop?.let {
                    val selected = RigMediaLimits.pixelCrop(width, height, it)
                    decoder.setCrop(android.graphics.Rect(selected[0], selected[1], selected[0] + selected[2], selected[1] + selected[3]))
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetColorSpace(android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB))
                decoder.isMutableRequired = false
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > 4096) sample *= 2
        val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }) }
            ?: throw IOException("Deze foto kon niet worden geopend.")
        val orientation = imageOrientation(uri)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(270f)
            }
        }
        if (matrix.isIdentity) return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).also { if (it !== bitmap) bitmap.recycle() }
    }

    private fun imageOrientation(uri: Uri): Int = runCatching {
        resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } ?: ExifInterface.ORIENTATION_NORMAL
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

    private fun renderImage(source: Bitmap, rect: IntArray, size: Pair<Int, Int>): Bitmap {
        val rendered = Bitmap.createBitmap(size.first, size.second, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(rendered)
            canvas.drawColor(Color.WHITE)
            canvas.drawBitmap(source, android.graphics.Rect(rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]), android.graphics.Rect(0, 0, size.first, size.second), Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
            return rendered
        } catch (error: Throwable) {
            rendered.recycle()
            throw error
        }
    }

    private fun writeJpeg(source: Bitmap, crop: NormalizedCrop, size: Pair<Int, Int>): PreparedAsset {
        val bitmap = renderImage(source, RigMediaLimits.pixelCrop(source.width, source.height, crop), size)
        val output = File(directory, "${UUID.randomUUID()}.jpg")
        try {
            output.outputStream().use { require(bitmap.compress(Bitmap.CompressFormat.JPEG, 94, it)) { "Deze foto kon niet worden voorbereid." } }
            require(output.length() in 1..RigMediaLimits.MAX_ASSET_BYTES) { "Deze foto kon niet veilig worden voorbereid." }
            return seal(output, "image/jpeg", size.first, size.second, null, false)
        } finally { bitmap.recycle(); output.delete() }
    }

    private fun seal(temp: File, mime: String, width: Int, height: Int, seconds: Int?, audio: Boolean): PreparedAsset {
        val digest = sha256(temp)
        // A random component prevents an older draft's cleanup deleting a file
        // still used by another draft, while its content hash binds the quote.
        val ready = File(directory, "$digest-${UUID.randomUUID()}.${if (seconds == null) "jpg" else "mp4"}")
        check(temp.renameTo(ready)) { "Het voorbereide bestand kon niet worden bewaard." }
        ready.setReadOnly()
        return PreparedAsset(ready, mime, width, height, seconds, digest, audio)
    }

    private fun displayDetails(uri: Uri): Pair<String, Long?> {
        if (uri.scheme == "file") { val file = File(uri.path ?: ""); return file.name.take(150) to file.length().takeIf { it > 0 } }
        var name = "Gekozen bestand"
        var bytes: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { if (!cursor.isNull(it)) name = cursor.getString(it).take(150) }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let { if (!cursor.isNull(it)) bytes = cursor.getLong(it).takeIf { n -> n >= 0 } }
            }
        }
        return name to bytes
    }

    private fun inferLocalMime(uri: Uri): String = when (uri.lastPathSegment?.substringAfterLast('.')?.lowercase()) {
        "mp4", "m4v" -> "video/mp4"
        "mov" -> "video/quicktime"
        "webm" -> "video/webm"
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "heic", "heif" -> "image/heic"
        "avif" -> "image/avif"
        else -> "application/octet-stream"
    }

    companion object {
        private const val PHOTO_CHECK_SIDE = 1024
        private val IMAGE_MIMES = setOf("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif")
        private val ROTATED_EXIF = setOf(ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE)
    }
}
