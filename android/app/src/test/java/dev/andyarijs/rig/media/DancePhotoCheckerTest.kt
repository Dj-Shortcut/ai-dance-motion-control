package dev.andyarijs.rig.media

import com.google.mlkit.vision.pose.PoseLandmark
import org.junit.Assert.assertEquals
import org.junit.Test

class DancePhotoCheckerTest {
    private val fullBody = listOf(
        PoseLandmark.NOSE to .12f,
        PoseLandmark.LEFT_SHOULDER to .28f, PoseLandmark.RIGHT_SHOULDER to .28f,
        PoseLandmark.LEFT_WRIST to .54f, PoseLandmark.RIGHT_WRIST to .54f,
        PoseLandmark.LEFT_HIP to .52f, PoseLandmark.RIGHT_HIP to .52f,
        PoseLandmark.LEFT_KNEE to .72f, PoseLandmark.RIGHT_KNEE to .72f,
        PoseLandmark.LEFT_ANKLE to .90f, PoseLandmark.RIGHT_ANKLE to .90f,
        PoseLandmark.LEFT_HEEL to .92f, PoseLandmark.RIGHT_FOOT_INDEX to .94f,
    ).map { (type, y) -> DanceLandmark(type, .5f, y, .95f) }

    @Test fun fullBodyWithBothFeetAndWristsIsSuitable() {
        assertEquals(DancePhotoAssessment.FULL_BODY, assessDancePose(fullBody))
    }

    @Test fun upperBodyWithFeetEstimatedOutsideTheCropIsPartial() {
        val cropped = fullBody.map { it.copy(y = it.y * 1.8f) }
        assertEquals(DancePhotoAssessment.PARTIAL_BODY, assessDancePose(cropped))
    }

    @Test fun uncertainOrMissingJointDoesNotQualifyAsFullBody() {
        val uncertain = fullBody.map { if (it.type == PoseLandmark.LEFT_KNEE) it.copy(confidence = .2f) else it }
        assertEquals(DancePhotoAssessment.PARTIAL_BODY, assessDancePose(uncertain))
        assertEquals(DancePhotoAssessment.PARTIAL_BODY, assessDancePose(fullBody.filterNot { it.type == PoseLandmark.LEFT_WRIST }))
    }

    @Test fun tinyBackgroundPersonIsNotRatedSuitable() {
        assertEquals(DancePhotoAssessment.PARTIAL_BODY, assessDancePose(fullBody.map { it.copy(y = .4f + it.y * .12f) }))
    }

    @Test fun missingUncertainOrInvalidDetectionsReturnNoClearPerson() {
        assertEquals(DancePhotoAssessment.NO_CLEAR_PERSON, assessDancePose(emptyList()))
        assertEquals(DancePhotoAssessment.NO_CLEAR_PERSON, assessDancePose(fullBody.map { it.copy(confidence = .22f) }))
        assertEquals(DancePhotoAssessment.NO_CLEAR_PERSON, assessDancePose(fullBody.map { it.copy(x = Float.NaN) }))
        assertEquals(DancePhotoAssessment.NO_CLEAR_PERSON, assessDancePose(fullBody.take(2)))
    }
}
