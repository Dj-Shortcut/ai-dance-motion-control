package dev.andyarijs.rig.media

import android.net.Uri
import java.io.File
import java.security.MessageDigest
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Coordinates are always relative to the upright, displayed image, not the encoded sensor. */
data class NormalizedCrop(val left: Float = 0f, val top: Float = 0f, val right: Float = 1f, val bottom: Float = 1f) {
    init {
        require(listOf(left, top, right, bottom).all { it.isFinite() }) { "Ongeldige uitsnede." }
        require(left >= 0 && top >= 0 && right <= 1 && bottom <= 1 && right > left && bottom > top) { "De uitsnede moet binnen het beeld vallen." }
    }
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    companion object { val FULL = NormalizedCrop() }
}

enum class NativeMediaKind { IMAGE, VIDEO }

data class NativeMediaSource(
    val uri: Uri,
    val kind: NativeMediaKind,
    val displayName: String,
    val mimeType: String,
    val sizeBytes: Long?,
    /** Upright dimensions, including the video's rotation or photograph's EXIF orientation. */
    val width: Int,
    val height: Int,
    val durationMs: Long = 0,
    val hasAudio: Boolean = false,
    val rotationDegrees: Int = 0,
    val frameRate: Float? = null
) {
    val isVideo: Boolean get() = kind == NativeMediaKind.VIDEO
}

/** An immutable, bounded derivative in private app storage. Original picker URIs are never uploads. */
data class PreparedAsset(
    val file: File,
    val mimeType: String,
    val width: Int,
    val height: Int,
    val durationSeconds: Int? = null,
    val revision: String,
    val hasAudio: Boolean = false
) {
    val sizeBytes: Long get() = file.length()
    init {
        require(mimeType == "image/jpeg" || mimeType == "video/mp4")
        require(width in 340..3850 && height in 340..3850)
        require((mimeType == "video/mp4") == (durationSeconds != null))
        require(durationSeconds == null || durationSeconds in 3..30)
        require(Regex("^[a-f0-9]{64}$").matches(revision))
    }
}

data class PreparedMediaRefs(
    val primary: PreparedAsset,
    val motion: PreparedAsset,
    val face: PreparedAsset? = null,
    val angles: List<PreparedAsset> = emptyList()
) {
    init {
        require(primary.mimeType == "image/jpeg" && motion.mimeType == "video/mp4")
        require(face == null || face.mimeType == "image/jpeg")
        require(angles.size <= 3 && angles.all { it.mimeType == "image/jpeg" })
        require(angles.isEmpty() || face != null) { "Voeg eerst een close-up toe voor extra hoeken." }
    }
    /** Bind a quote to these exact derivatives; any changed media invalidates it. */
    val revision: String get() = sha256((listOf(primary, motion) + listOfNotNull(face) + angles).joinToString("|") { it.revision }.toByteArray())
}

data class NativeVideoPlan(val startMs: Long, val exportDurationMs: Long, val selectedDurationSeconds: Int, val width: Int, val height: Int)

/** Pure geometry and limits, shared by preview, exporter and tests. */
object RigMediaLimits {
    const val MAX_ASSET_BYTES = 16L * 1024 * 1024
    const val MAX_IMAGE_SIDE = 2048
    const val MAX_VIDEO_SIDE = 1280
    const val MIN_SIDE = 340

    fun pixelCrop(width: Int, height: Int, crop: NormalizedCrop): IntArray {
        require(width > 0 && height > 0)
        val left = floor(width * crop.left.toDouble() + .001).toInt().coerceIn(0, width - 1)
        val top = floor(height * crop.top.toDouble() + .001).toInt().coerceIn(0, height - 1)
        val right = ceil(width * crop.right.toDouble() - .001).toInt().coerceIn(left + 1, width)
        val bottom = ceil(height * crop.bottom.toDouble() - .001).toInt().coerceIn(top + 1, height)
        return intArrayOf(left, top, right - left, bottom - top)
    }

    fun imageDimensions(width: Int, height: Int, crop: NormalizedCrop): Pair<Int, Int> {
        val rect = pixelCrop(width, height, crop)
        require(rect[2] >= MIN_SIDE && rect[3] >= MIN_SIDE) { "Kies een foto of uitsnede van minstens 340 × 340 pixels." }
        val aspect = rect[2].toDouble() / rect[3]
        require(aspect in 0.4..2.5) { "Maak de uitsnede iets breder of hoger." }
        val scale = min(1.0, MAX_IMAGE_SIDE.toDouble() / max(rect[2], rect[3]))
        val width = max(MIN_SIDE, floor(rect[2] * scale).toInt())
        val height = max(MIN_SIDE, floor(rect[3] * scale).toInt())
        // At the aspect limit, rounding the short edge down would make the JPEG invalid for upload.
        return max(width, ceil(height / 2.5).toInt()) to max(height, ceil(width / 2.5).toInt())
    }

    fun exportLengthMs(durationSeconds: Int): Long = if (durationSeconds == 3) 3_120L else durationSeconds * 1_000L

    fun requireMotionLength(durationMs: Long, quality: String?) {
        val recast = quality == "human-recast"
        require(durationMs >= exportLengthMs(if (recast) 6 else 3)) {
            if (recast) "Kies voor deze bewerking een bewegingsvideo van minstens 6 seconden."
            else "Kies een bewegingsvideo van minstens 3,12 seconden."
        }
    }

    fun videoPlan(sourceWidth: Int, sourceHeight: Int, sourceDurationMs: Long, startMs: Long, durationSeconds: Int, crop: NormalizedCrop = NormalizedCrop.FULL, minSide: Int = 0, maxDurationSeconds: Int = 30): NativeVideoPlan {
        require(maxDurationSeconds in setOf(15, 30) && durationSeconds in 3..maxDurationSeconds) { "Kies een fragment van 3 tot $maxDurationSeconds seconden." }
        require(startMs >= 0 && startMs <= 3_600_000) { "Kies een geldig beginpunt." }
        require(minSide == 0 || minSide == 720)
        // The server's minimum three-second transform needs 3.08 s of source.
        // Other clips keep the chosen duration. Never silently shorten a user's selection.
        val length = exportLengthMs(durationSeconds)
        require(startMs <= sourceDurationMs && length <= sourceDurationMs - startMs) { "Dit fragment valt buiten de video. Kies een eerder beginpunt of een kortere duur." }
        val rect = pixelCrop(sourceWidth, sourceHeight, crop)
        require(min(rect[2], rect[3]) >= max(MIN_SIDE, minSide)) { "Kies een video of uitsnede van minstens ${max(MIN_SIDE, minSide)} × ${max(MIN_SIDE, minSide)} pixels." }
        val scale = min(1.0, MAX_VIDEO_SIDE.toDouble() / max(rect[2], rect[3]))
        val scaledWidth = max(2, floor(rect[2] * scale / 2).toInt() * 2)
        val scaledHeight = max(2, floor(rect[3] * scale / 2).toInt() * 2)
        // Letterbox instead of cutting the top/bottom off a tall screen recording.
        val width = max(scaledWidth, max(MIN_SIDE, minSide))
        val height = max(scaledHeight, max(MIN_SIDE, minSide))
        return NativeVideoPlan(startMs, length, durationSeconds, width, height)
    }
}

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

internal fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
}
