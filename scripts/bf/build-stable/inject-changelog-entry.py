#!/usr/bin/env python3
"""Inject a brightfire build section into CHANGELOG.md.

Reads the pinned patch manifest, resolves each patch's actual merged SHA
from git, and injects a ## <version> section before the first upstream
heading. Idempotent — exits 0 if the section already exists.

Environment:
  BF_VERSION       — the bf/v<version>-<N> tag for this build
  UPSTREAM_VERSION — the upstream version string (e.g., 2026.8.2)
  REPO             — the GitHub repo URL for commit links
  PATCHES_FILE     — path to BRIGHTFIRE_PATCHES.md
"""

import os, re, subprocess, sys

version  = os.environ['BF_VERSION']
upstream = os.environ['UPSTREAM_VERSION']
repo     = os.environ['REPO']
manifest = os.environ['PATCHES_FILE']
changelog = 'CHANGELOG.md'

# Parse patch table: Name | Canonical branch | Branch HEAD | ...
entries = []
in_table = False
with open(manifest) as f:
    for line in f:
        line = line.rstrip()
        if line.startswith('| Name'):
            in_table = True
            continue
        if not in_table:
            continue
        if not line.startswith('|'):
            break
        if re.match(r'^\|[-| ]+\|\s*$', line):
            continue
        cols = [c.strip() for c in line.split('|')[1:-1]]
        if len(cols) < 2:
            continue
        name = cols[0].strip()
        branch = cols[1].strip()
        # Strip markdown code formatting
        branch = re.sub(r'^`(.+)`$', r'\1', branch)
        if name and branch:
            entries.append((name, branch))

if not entries:
    print(f'No patches found in {manifest}', file=sys.stderr)
    sys.exit(1)

# Resolve each patch's actual merged SHA from the fetched remote ref.
patches = []
for name, branch in entries:
    ref = f'origin/{branch}'
    result = subprocess.run(
        ['git', 'rev-parse', ref],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f'WARNING: could not resolve {ref}: {result.stderr.strip()}', file=sys.stderr)
        continue
    sha = result.stdout.strip()[:10]
    patches.append((name, sha))

if not patches:
    print('No patch SHAs could be resolved from git refs', file=sys.stderr)
    sys.exit(1)

# Build the section
section_lines = [
    f'## {version}',
    '',
    f'Brightfire build on upstream {upstream}.',
    '',
    '### Patches',
    '',
]
for name, sha in patches:
    section_lines.append(f'- **{name}** \u2014 [`{sha}`]({repo}/commit/{sha})')
section_lines.append('')
section = '\n'.join(section_lines) + '\n'

# Read changelog and check for existing entry
with open(changelog) as f:
    content = f.read()

marker = f'## {version}'
if re.search(r'^' + re.escape(marker) + r'(\s|$)', content, re.MULTILINE):
    print(f'CHANGELOG already contains entry for {version}', file=sys.stderr)
    sys.exit(0)

# Inject before the first ## heading
m = re.search(r'^## ', content, re.MULTILINE)
if m:
    content = content[:m.start()] + section + '\n' + content[m.start():]
else:
    content = section + '\n' + content

with open(changelog, 'w') as f:
    f.write(content)

print(f'Injected CHANGELOG entry for {version} ({len(patches)} patches)', file=sys.stderr)
