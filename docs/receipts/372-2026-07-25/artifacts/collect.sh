#!/usr/bin/env bash
# Names the tier-3 captures. SRC is the extension's screenshot scratch directory.
set -eu
SRC=${SRC:?set SRC}
DEST=${DEST:?set DEST}
i=8
for scheme in light dark; do
  for route in overview chats repositories agents runtime secrets logs; do
    cp "$SRC/$(ls "$SRC" | grep -E -- "-$i\.jpg$")" "$DEST/$scheme-$route.jpg"
    i=$((i + 1))
  done
done
cp "$SRC/$(ls "$SRC" | grep -E -- '\-2\.jpg$')" "$DEST/dark-sign-in.jpg"
ls "$DEST"
