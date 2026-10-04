#!/bin/sh
# Package and install PianoSmith on a Samsung TV.
# Usage: TV_IP=192.168.0.165 ./scripts/tizen-install.sh
set -e
cd "$(dirname "$0")/.."
TV_IP="${TV_IP:-192.168.0.165}"
npm run build
cd tizen-app
tizen package -t wgt -- .
WGT=$(ls -1 *.wgt | head -n 1)
if sdb connect "$TV_IP:26101" 2>&1 | grep -q "server listener"; then
  killall sdb || true
  sleep 2
  sdb start-server
  sleep 2
  sdb connect "$TV_IP:26101"
fi
tizen install -n "$WGT" -t "$TV_IP:26101"
echo "Installed $WGT on $TV_IP"
