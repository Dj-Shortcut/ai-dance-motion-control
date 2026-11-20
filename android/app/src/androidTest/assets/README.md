`native-media-fixture.mp4` is a source-controlled, entirely synthetic 93 KiB
fixture: nine seconds of color blocks, 720×1280 H264 at 30 fps, with a 440 Hz AAC
tone. It contains no customer media. Regenerate with an installed `ffmpeg`:

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
