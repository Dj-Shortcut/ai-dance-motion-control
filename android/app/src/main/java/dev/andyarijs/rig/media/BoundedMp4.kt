package dev.andyarijs.rig.media

import java.io.File
import java.io.RandomAccessFile

/** Android MediaMuxer reserves a 16-byte, 64-bit mdat header even for tiny
 * exports. RIG's bounded MP4 verifier deliberately accepts ordinary 32-bit
 * boxes only. Replace that header with free(8)+mdat(8), retaining every payload
 * position, sample table, timestamp and encoded byte. This is not a remux or
 * another encode, and never touches the user's source. */
internal fun normalizeBoundedMp4(file: File) {
    require(file.length() in 24..RigMediaLimits.MAX_ASSET_BYTES) { "Het voorbereide fragment heeft geen geldig formaat." }
    RandomAccessFile(file, "rw").use { data ->
        val length = data.length()
        var position = 0L
        var boxes = 0
        var mediaBoxes = 0
        while (position < length) {
            require(++boxes <= 256 && length - position >= 8) { "Het voorbereide fragment heeft geen geldige MP4-indeling." }
            data.seek(position)
            val size = data.readInt().toLong() and 0xffff_ffffL
            val typeBytes = ByteArray(4).also { data.readFully(it) }
            val type = typeBytes.toString(Charsets.US_ASCII)
            if (type == "mdat") mediaBoxes++
            val boxLength = if (size == 1L) {
                require(type == "mdat" && length - position >= 16) { "Dit MP4-formaat kan niet veilig worden voorbereid." }
                val extended = data.readLong()
                require(extended in 17..(length - position) && extended <= Int.MAX_VALUE) { "Het voorbereide fragment heeft een ongeldige MP4-lengte." }
                data.seek(position)
                data.writeInt(8)
                data.writeBytes("free")
                data.writeInt((extended - 8).toInt())
                data.writeBytes("mdat")
                extended
            } else {
                require(size in 8..(length - position)) { "Het voorbereide fragment heeft een ongeldige MP4-lengte." }
                size
            }
            position += boxLength
        }
        require(position == length && mediaBoxes == 1) { "Het voorbereide fragment bevat geen geschikte videogegevens." }
    }
}
