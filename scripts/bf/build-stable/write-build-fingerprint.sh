#!/usr/bin/env bash
# Emit bf-build-fingerprint.json for the just-built release.
#
# The fingerprint covers ALL inputs that determine the release artifact:
# the patch manifest, the build workflow, and the build scripts. This way
# a fix to bf-build-stable.yml or scripts/bf/** triggers a release even
# when the manifest itself is unchanged.
#
# Inputs (env):
#   MANIFEST_SHA256 — sha256 of BRIGHTFIRE_PATCHES.md that drove this build
#   RELEASE_TAG     — full release tag (e.g. bf/v2026.8.2-1)
#   OUTPUT_PATH     — where to write the JSON file
#   WORKSPACE       — repo root (default: cwd; for hashing build inputs)

set -euo pipefail

: "${MANIFEST_SHA256:?MANIFEST_SHA256 required}"
: "${RELEASE_TAG:?RELEASE_TAG required}"
: "${OUTPUT_PATH:?OUTPUT_PATH required}"
WORKSPACE="${WORKSPACE:-$(pwd)}"

BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Composite hash: manifest + workflow + build scripts. Order is deterministic.
# Any change to any of these inputs produces a different composite sha,
# which means the next check-release-needed.sh comparison detects the change
# and triggers a release.
COMPOSITE_SHA=$(
  cd "$WORKSPACE"
  {
    echo "manifest:"
    cat BRIGHTFIRE_PATCHES.md
    echo "workflow:"
    cat .github/workflows/bf-build-stable.yml
    echo "scripts:"
    find scripts/bf/ -type f -name '*.sh' -o -name '*.py' | sort | while read f; do
      echo "--- $f"
      cat "$f"
    done
  } | sha256sum | awk '{print $1}'
)

python3 - <<'PY' "$MANIFEST_SHA256" "$COMPOSITE_SHA" "$RELEASE_TAG" "$BUILT_AT" "$OUTPUT_PATH"
import json, sys
manifest_sha, build_input_sha, tag, built_at, out = sys.argv[1:6]
with open(out, "w") as f:
    json.dump({
        "manifest_sha256": manifest_sha,
        "build_input_sha256": build_input_sha,
        "release_tag": tag,
        "built_at": built_at,
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY

echo "Wrote build fingerprint to $OUTPUT_PATH"
cat "$OUTPUT_PATH"
