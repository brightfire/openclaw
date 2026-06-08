#!/usr/bin/env bash
# Emit bf-build-fingerprint.json for the just-built release.
#
# The fingerprint is uploaded as a release asset and read by the next run of
# check-manifest-fingerprint.sh to decide whether the manifest changed.
#
# Inputs (env):
#   MANIFEST_SHA256 — sha256 of BRIGHTFIRE_PATCHES.md that drove this build
#   RELEASE_TAG     — full release tag (e.g. bf/v2026.5.7-bf5)
#   OUTPUT_PATH     — where to write the JSON file
#
# Output: a single JSON file at $OUTPUT_PATH with shape:
#   {
#     "manifest_sha256": "...",
#     "release_tag":     "bf/vX.Y.Z-bfN",
#     "built_at":        "<ISO 8601 UTC>"
#   }

set -euo pipefail

: "${MANIFEST_SHA256:?MANIFEST_SHA256 required}"
: "${RELEASE_TAG:?RELEASE_TAG required}"
: "${OUTPUT_PATH:?OUTPUT_PATH required}"

BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 - <<'PY' "$MANIFEST_SHA256" "$RELEASE_TAG" "$BUILT_AT" "$OUTPUT_PATH"
import json, sys
sha, tag, built_at, out = sys.argv[1:5]
with open(out, "w") as f:
    json.dump({
        "manifest_sha256": sha,
        "release_tag": tag,
        "built_at": built_at,
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY

echo "Wrote build fingerprint to $OUTPUT_PATH"
cat "$OUTPUT_PATH"
