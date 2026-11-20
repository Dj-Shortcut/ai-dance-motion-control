package dev.andyarijs.rig.media

import org.junit.Assert.*
import org.junit.Test

class RigMediaLimitsTest {
    @Test fun largePhonePhotoUsesBoundedDerivative() {
        assertEquals(1536 to 2048, RigMediaLimits.imageDimensions(12_000, 16_000, NormalizedCrop.FULL))
        assertEquals(2048 to 1536, RigMediaLimits.imageDimensions(16_000, 12_000, NormalizedCrop.FULL))
    }

    @Test fun cropCoordinatesReferToUprightFullImage() {
        assertArrayEquals(intArrayOf(100, 300, 600, 900), RigMediaLimits.pixelCrop(1000, 1500, NormalizedCrop(.1f, .2f, .7f, .8f)))
    }

    @Test fun fourKClipIsShortAndBoundedWithUnchangedStart() {
        val plan = RigMediaLimits.videoPlan(2160, 3840, 180_000, 22_500, 30)
        assertEquals(22_500, plan.startMs)
        assertEquals(30_000, plan.exportDurationMs)
        assertEquals(720, plan.width)
        assertEquals(1280, plan.height)
    }

    @Test fun tallScreenRecordingPadsInsteadOfLosingContent() {
        val plan = RigMediaLimits.videoPlan(742, 1322, 60_000, 0, 6, minSide = 720)
        assertEquals(720, plan.width)
        assertEquals(1280, plan.height)
    }

    @Test fun minimumClipIncludesServerVerificationTail() {
        assertEquals(3120, RigMediaLimits.videoPlan(1920, 1080, 10_000, 1000, 3).exportDurationMs)
        invalid { RigMediaLimits.videoPlan(1920, 1080, 3000, 0, 3) }
    }

    @Test fun motionSelectionHonorsTheMinimumForTheChosenModel() {
        for (quality in listOf("standard", "pro", "edit-standard")) {
            invalid { RigMediaLimits.requireMotionLength(3100, quality) }
            invalid { RigMediaLimits.requireMotionLength(3119, quality) }
            RigMediaLimits.requireMotionLength(3120, quality)
        }
        invalid { RigMediaLimits.requireMotionLength(5999, "human-recast") }
        RigMediaLimits.requireMotionLength(6000, "human-recast")
    }

    @Test fun roundedPhotoDimensionsRemainWithinTheUploadAspectLimits() {
        assertEquals(2048 to 820, RigMediaLimits.imageDimensions(2500, 1000, NormalizedCrop.FULL))
        assertEquals(820 to 2048, RigMediaLimits.imageDimensions(1000, 2500, NormalizedCrop.FULL))
        invalid { RigMediaLimits.imageDimensions(2501, 1000, NormalizedCrop.FULL) }
    }

    @Test fun refusesImpossibleSelectionRatherThanSilentlyChangingDuration() {
        invalid { RigMediaLimits.videoPlan(1920, 1080, 10_000, 6_000, 5) }
        invalid { RigMediaLimits.videoPlan(1920, 1080, 100_000, 0, 16, maxDurationSeconds = 15) }
        invalid { RigMediaLimits.videoPlan(1920, 1080, 100_000, -1, 6) }
        invalid { RigMediaLimits.videoPlan(1920, 1080, 100_000, 0, 31) }
    }

    @Test fun croppingBelowBackendOrEditModelMinimumIsRejected() {
        invalid { RigMediaLimits.imageDimensions(1000, 1000, NormalizedCrop(0f, 0f, .2f, .5f)) }
        invalid { RigMediaLimits.videoPlan(1920, 1080, 10_000, 0, 5, NormalizedCrop(0f, 0f, .25f, 1f), minSide = 720) }
    }

    @Test fun normalizedCropRejectsNonFiniteOrOutsideCoordinates() {
        invalid { NormalizedCrop(Float.NaN, 0f, 1f, 1f) }
        invalid { NormalizedCrop(-.1f, 0f, 1f, 1f) }
        invalid { NormalizedCrop(.8f, 0f, .2f, 1f) }
    }

    private fun invalid(block: () -> Unit) {
        try { block(); fail("Expected a rejected selection") } catch (_: IllegalArgumentException) { }
    }
}
