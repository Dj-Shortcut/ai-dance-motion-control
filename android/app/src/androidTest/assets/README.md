`native-media-fixture.mp4` is generated locally by Gradle from an entirely
synthetic fixture: just under nine seconds of color blocks, 720×1280 H264 at 30 fps, with a 440 Hz AAC
tone. This fractional duration exercises trial continuation with a nine-second selection.
It contains no customer media. Install `ffmpeg` before building the instrumentation APK. Gradle generates it
under `app/build/generated/rigTestAssets/`; no binary media is tracked. To generate it manually:

    sh android/scripts/create-media-test-fixture.sh

Instrumentation exercises Android's actual decoder, EXIF orientation, local
crop/trim, AAC retention/removal and bounded MP4 export without any network or
provider account. `RigNativeUiTest` opens the real native activity and performs
the crop gesture and media/prompt screen flow.

The large-phone-video test is explicitly optional, because personal videos must
never enter the repository. Copy the real file into the test app's private
`files/ik.mp4` on a dedicated emulator, then run with:

    adb -s emulator-5580 shell am instrument -w -r \
      -e class dev.andyarijs.rig.media.RigMediaInstrumentationTest \
      -e rigSourceVideoPath /data/user/0/dev.andyarijs.rig/files/ik.mp4 \
      dev.andyarijs.rig.test/androidx.test.runner.AndroidJUnitRunner

All derivatives remain under the app's private cache. No test invokes Fal or
creates a paid generation. Screenshots and normalized exports are local test
evidence, not fabricated provider results.

The dance photo UI test always checks an image without a person. To also exercise
the bundled model on a full-body photo and an upper-body crop of the same photo,
use MediaPipe's [public pose test image](https://storage.googleapis.com/mediapipe-assets/pose.jpg)
(SHA-256 `c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b`).
After installing the debug app and test APK on the emulator, run:

    adb shell run-as dev.andyarijs.rig mkdir -p files
    adb push pose.jpg /data/local/tmp/rig-pose.jpg
    adb shell run-as dev.andyarijs.rig cp /data/local/tmp/rig-pose.jpg files/pose.jpg
    adb shell am instrument -w -r -e class dev.andyarijs.rig.DancePhotoAdviceUiTest \
      -e rigPosePhotoPath /data/user/0/dev.andyarijs.rig/files/pose.jpg \
      dev.andyarijs.rig.test/androidx.test.runner.AndroidJUnitRunner

The test also runs with the emulator in airplane mode.
