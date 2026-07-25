#!/usr/bin/env bash
# Names the tier-3 captures. SRC is the extension's screenshot scratch directory, holding exactly
# the 15 shots of one capture run, oldest first: sign-in, then 7 light routes, then 7 dark.
set -eu
SRC=${SRC:?set SRC}
DEST=${DEST:?set DEST}
shots=()
while IFS= read -r shot; do shots+=("$shot"); done < <(ls -tr "$SRC"/*.jpg)
[ "${#shots[@]}" -eq 15 ] || { echo "expected 15 shots, found ${#shots[@]}" >&2; exit 1; }
cp "${shots[0]}" "$DEST/light-sign-in.jpg"
i=1
for scheme in light dark; do
  for route in overview chats repositories agents runtime secrets logs; do
    cp "${shots[$i]}" "$DEST/$scheme-$route.jpg"
    i=$((i + 1))
  done
done
chmod 644 "$DEST"/*.jpg
ls "$DEST"
