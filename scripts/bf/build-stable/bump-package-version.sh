#!/usr/bin/env bash
# Rewrite package.json#version to the computed bf version and commit.
#
# Inputs (env):
#   VERSION — X.Y.Z-{N} from compute-bf-version.sh

set -euo pipefail

if [ -z "${VERSION:-}" ]; then
  echo "::error::bump-package-version.sh requires VERSION env var"
  exit 2
fi

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\n');
"
git add package.json
git commit --no-verify -m "ci: bump version to $VERSION"
