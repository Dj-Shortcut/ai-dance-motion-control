package dev.andyarijs.rig.media

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlin.math.hypot

/** A crop is edited against the full upright source, never a previously cropped thumbnail. */
@Composable
fun NativeCropDialog(
    source: NativeMediaSource,
    framePositionMs: Long = 0,
    initialCrop: NormalizedCrop = NormalizedCrop.FULL,
    onDismiss: () -> Unit,
    onApply: (NormalizedCrop) -> Unit
) {
    val context = LocalContext.current
    var bitmap by remember(source.uri, framePositionMs) { mutableStateOf<Bitmap?>(null) }
    var error by remember(source.uri, framePositionMs) { mutableStateOf<String?>(null) }
    var crop by remember(source.uri, initialCrop) { mutableStateOf(initialCrop) }
    LaunchedEffect(source.uri, framePositionMs) {
        try { bitmap = RigMediaPreparer(context).previewBitmap(source, framePositionMs) }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { error = "Dit beeld kon niet worden geopend. Kies een ander moment of bestand." }
    }
    DisposableEffect(bitmap) {
        val owned = bitmap
        onDispose { owned?.recycle() }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Uitsnijden") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                when {
                    error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
                    bitmap == null -> CircularProgressIndicator()
                    else -> {
                        Text("Sleep de hoeken.", style = MaterialTheme.typography.bodySmall)
                        BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            val aspect = bitmap!!.width.toFloat() / bitmap!!.height
                            val height = minOf(maxWidth / aspect, 430.dp)
                            CropCanvas(bitmap!!, crop, { crop = it }, Modifier.width(height * aspect).height(height))
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { crop = NormalizedCrop.FULL }) { Text("Herstellen") }
                }
            }
        },
        confirmButton = { TextButton(enabled = bitmap != null && error == null, onClick = { onApply(crop) }) { Text("Gebruik uitsnede") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annuleren") } }
    )
}

@Composable
internal fun CropCanvas(bitmap: Bitmap, crop: NormalizedCrop, onCrop: (NormalizedCrop) -> Unit, modifier: Modifier = Modifier) {
    var value by remember { mutableStateOf(crop) }
    LaunchedEffect(crop) { value = crop }
    var active by remember { mutableStateOf(-1) }
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    Box(modifier) {
        Image(image, contentDescription = "Volledig bronbeeld", modifier = Modifier.matchParentSize())
        Canvas(Modifier.matchParentSize().testTag("rig-crop-canvas").pointerInput(bitmap) {
            detectDragGestures(
                onDragStart = { point ->
                    val c = value
                    val corners = listOf(Offset(c.left * size.width, c.top * size.height), Offset(c.right * size.width, c.top * size.height), Offset(c.right * size.width, c.bottom * size.height), Offset(c.left * size.width, c.bottom * size.height))
                    val closest = corners.indices.minByOrNull { i -> hypot((corners[i].x - point.x).toDouble(), (corners[i].y - point.y).toDouble()) } ?: 0
                    active = if ((corners[closest] - point).getDistance() <= 52.dp.toPx()) closest
                    else if (point.x / size.width in c.left..c.right && point.y / size.height in c.top..c.bottom) 4 else -1
                },
                onDragEnd = { active = -1 },
                onDragCancel = { active = -1 }
            ) { change, delta ->
                if (active < 0) return@detectDragGestures
                change.consume()
                val dx = delta.x / size.width
                val dy = delta.y / size.height
                val c = value
                val minimumX = (64f / bitmap.width).coerceIn(.04f, .3f)
                val minimumY = (64f / bitmap.height).coerceIn(.04f, .3f)
                value = when (active) {
                    0 -> c.copy(left = (c.left + dx).coerceIn(0f, c.right - minimumX), top = (c.top + dy).coerceIn(0f, c.bottom - minimumY))
                    1 -> c.copy(right = (c.right + dx).coerceIn(c.left + minimumX, 1f), top = (c.top + dy).coerceIn(0f, c.bottom - minimumY))
                    2 -> c.copy(right = (c.right + dx).coerceIn(c.left + minimumX, 1f), bottom = (c.bottom + dy).coerceIn(c.top + minimumY, 1f))
                    3 -> c.copy(left = (c.left + dx).coerceIn(0f, c.right - minimumX), bottom = (c.bottom + dy).coerceIn(c.top + minimumY, 1f))
                    else -> {
                        val left = (c.left + dx).coerceIn(0f, 1 - c.width)
                        val top = (c.top + dy).coerceIn(0f, 1 - c.height)
                        NormalizedCrop(left, top, left + c.width, top + c.height)
                    }
                }
                onCrop(value)
            }
        }) {
            val rect = Rect(value.left * size.width, value.top * size.height, value.right * size.width, value.bottom * size.height)
            val shade = Color.Black.copy(alpha = .58f)
            drawRect(shade, size = androidx.compose.ui.geometry.Size(size.width, rect.top))
            drawRect(shade, Offset(0f, rect.bottom), androidx.compose.ui.geometry.Size(size.width, size.height - rect.bottom))
            drawRect(shade, Offset(0f, rect.top), androidx.compose.ui.geometry.Size(rect.left, rect.height))
            drawRect(shade, Offset(rect.right, rect.top), androidx.compose.ui.geometry.Size(size.width - rect.right, rect.height))
            drawRect(Color.White, rect.topLeft, rect.size, style = Stroke(2.dp.toPx()))
            val length = 20.dp.toPx()
            val thickness = 4.dp.toPx()
            listOf(rect.topLeft to Offset(1f, 1f), rect.topRight to Offset(-1f, 1f), rect.bottomRight to Offset(-1f, -1f), rect.bottomLeft to Offset(1f, -1f)).forEach { (point, direction) ->
                drawLine(Color.White, point, point + Offset(length * direction.x, 0f), thickness)
                drawLine(Color.White, point, point + Offset(0f, length * direction.y), thickness)
            }
        }
    }
}
