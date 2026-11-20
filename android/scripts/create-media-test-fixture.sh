#!/bin/sh
set -eu
android_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture="${1:-$android_root/app/build/generated/rigTestAssets/native-media-fixture.mp4}"
mkdir -p "$(dirname -- "$fixture")"
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x264337:s=720x1280:r=30:d=8.96,drawbox=x=0:y=0:w=360:h=640:color=red:t=fill,drawbox=x=360:y=640:w=360:h=640:color=blue:t=fill,drawbox=x=240:y=440:w=240:h=400:color=yellow:t=fill:enable='between(t,1,3.9)',drawbox=x=240:y=440:w=240:h=400:color=magenta:t=fill:enable='gte(t,4)'" \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=8.96' \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 28 \
  -c:a aac -b:a 64k -movflags +faststart -shortest -y "$fixture"
