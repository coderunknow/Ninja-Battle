#!/bin/sh
# Builds a stub libasound.so.2 so node-web-audio-api can be loaded in a sandbox
# with no sound hardware and no root to install libasound2.
#
# OfflineAudioContext never opens a device, so inert stubs are enough to render
# the soundtrack for offline analysis/export (tools/audio-render.mjs). This is a
# QA dependency only — the shipped app uses the browser's own Web Audio.
set -e
cd "$(dirname "$0")"
NODE_BIN="../node_modules/node-web-audio-api/node-web-audio-api.linux-x64-gnu.node"
[ -f "$NODE_BIN" ] || { echo "node-web-audio-api not installed"; exit 1; }
python3 build.py "$NODE_BIN"
gcc -shared -fPIC -Wl,--version-script=ver.map -o libasound.so.2 libasound.c
echo "built libasound.so.2"
