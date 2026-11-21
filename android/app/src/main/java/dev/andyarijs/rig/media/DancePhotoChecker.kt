package dev.andyarijs.rig.media

import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseLandmark
import com.google.mlkit.vision.pose.accurate.AccuratePoseDetectorOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.math.max

enum class DancePhotoAssessment { FULL_BODY, PARTIAL_BODY, NO_CLEAR_PERSON }

internal class DancePhotoChecker(private val media: RigMediaPreparer) {
    private val processing = Mutex()

    suspend fun check(source: NativeMediaSource, frameMs: Long, crop: NormalizedCrop): DancePhotoAssessment =
        processing.withLock {
            withContext(Dispatchers.IO) {
                ensureActive()
                val bitmap = media.photoCheckBitmap(source, frameMs, crop)
                try {
                    ensureActive()
                    val options = AccuratePoseDetectorOptions.Builder()
                        .setDetectorMode(AccuratePoseDetectorOptions.SINGLE_IMAGE_MODE)
                        .setPreferredHardwareConfigs(AccuratePoseDetectorOptions.CPU)
                        .build()
                    PoseDetection.getClient(options).use { detector ->
                        // The model may still read these pixels after cancellation. Finish its single
                        // in-flight task before releasing either resource or starting another check.
                        val pose = Tasks.await(detector.process(InputImage.fromBitmap(bitmap, 0)))
                        ensureActive()
                        assessDancePose(pose.allPoseLandmarks.map {
                            DanceLandmark(it.landmarkType, it.position.x / bitmap.width, it.position.y / bitmap.height, it.inFrameLikelihood)
                        })
                    }
                } finally { bitmap.recycle() }
            }
        }
}

/** Position in the selected, upright crop. ML Kit can estimate joints outside that crop. */
internal data class DanceLandmark(val type: Int, val x: Float, val y: Float, val confidence: Float)

private val fullBodyJoints = setOf(
    PoseLandmark.LEFT_SHOULDER, PoseLandmark.RIGHT_SHOULDER, PoseLandmark.LEFT_WRIST, PoseLandmark.RIGHT_WRIST,
    PoseLandmark.LEFT_HIP, PoseLandmark.RIGHT_HIP, PoseLandmark.LEFT_KNEE, PoseLandmark.RIGHT_KNEE,
    PoseLandmark.LEFT_ANKLE, PoseLandmark.RIGHT_ANKLE,
)

internal fun assessDancePose(landmarks: List<DanceLandmark>): DancePhotoAssessment {
    val visible = landmarks.filter { it.confidence >= 0.65f && it.x >= 0f && it.x < 1f && it.y >= 0f && it.y < 1f }
    val parts = visible.mapTo(mutableSetOf()) { it.type }
    if (parts.size < 3) return DancePhotoAssessment.NO_CLEAR_PERSON
    val head = PoseLandmark.NOSE in parts || PoseLandmark.LEFT_EAR in parts || PoseLandmark.RIGHT_EAR in parts
    val leftFoot = PoseLandmark.LEFT_HEEL in parts || PoseLandmark.LEFT_FOOT_INDEX in parts
    val rightFoot = PoseLandmark.RIGHT_HEEL in parts || PoseLandmark.RIGHT_FOOT_INDEX in parts
    // Tiny background figures offer little detail even when all predicted joints are in frame.
    val extent = max(visible.maxOf { it.x } - visible.minOf { it.x }, visible.maxOf { it.y } - visible.minOf { it.y })
    return if (head && leftFoot && rightFoot && parts.containsAll(fullBodyJoints) && extent >= 0.35f) {
        DancePhotoAssessment.FULL_BODY
    } else DancePhotoAssessment.PARTIAL_BODY
}
