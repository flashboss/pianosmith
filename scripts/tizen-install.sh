#!/bin/sh
# Package and install PianoSmith on a Samsung TV.
# Usage: TV_IP=192.168.0.165 ./scripts/tizen-install.sh
set -e
cd "$(dirname "$0")/.."
TV_IP="${TV_IP:-192.168.0.165}"
SERIAL="${TV_IP}:26101"

# Tizen Studio CLI (not always on PATH in non-login shells).
TIZEN_STUDIO="${TIZEN_STUDIO:-$HOME/tizen-studio}"
export PATH="$TIZEN_STUDIO/tools/ide/bin:$TIZEN_STUDIO/tools:$PATH"

npm run build
cd tizen-app
tizen package -t wgt -- .
WGT=$(ls -1 *.wgt | head -n 1)

connect_tv() {
  if sdb connect "$SERIAL" 2>&1 | grep -qE 'server listener|cannot bind|failed to connect'; then
    killall sdb 2>/dev/null || true
    sleep 2
    sdb start-server
    sleep 2
    sdb connect "$SERIAL"
  fi
}

connect_tv
if ! tizen install -n "$WGT" -s "$SERIAL"; then
  killall sdb 2>/dev/null || true
  sleep 2
  sdb start-server
  sleep 2
  sdb connect "$SERIAL"
  sleep 1
  tizen install -n "$WGT" -s "$SERIAL"
fi
echo "Installed $WGT on $TV_IP"
