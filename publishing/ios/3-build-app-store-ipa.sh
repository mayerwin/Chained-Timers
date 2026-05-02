#!/usr/bin/env bash
# =====================================================================
# Build the App Store IPA (macOS only).
#
# Final output:
#   publishing/ios/chained-timers-v<version>.ipa
#   publishing/ios/chained-timers-v<version>.xcarchive (the archive)
#
# Equivalent of publishing/android/3-build-play-aab.bat for iOS:
# runs cap:sync, archives the workspace, and exports a signed IPA next
# to the rest of the publishing material so it's easy to find when
# uploading to App Store Connect.
#
# Steps:
#   1. npm run cap:sync                           (build dist/, sync iOS project)
#   2. xcodebuild archive                         (compile + sign)
#   3. xcodebuild -exportArchive                  (produce uploadable IPA)
#   4. Move/rename the IPA into publishing/ios/.
#
# Prerequisites:
#   - macOS with Xcode + Command Line Tools installed.
#   - The ios/ Capacitor project has been scaffolded once via
#     `npm run cap:add:ios` and the workspace builds in Xcode (signing
#     team set, bundle id available, etc. -- see publishing/ios/README.md
#     section 4 for the one-time signing setup).
#   - publishing/ios/ExportOptions.plist exists (committed alongside
#     this script). Update its `teamID` line on first use.
#
# Note on signing: -allowProvisioningUpdates lets Xcode fetch / refresh
# provisioning profiles automatically, mirroring the GUI Distribute App
# flow. If your account isn't signed into Xcode (Xcode > Settings >
# Accounts), the build will fail with a clear "no signing certificates"
# error -- fix that once and re-run.
# =====================================================================

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

echo
echo "=== Build App Store IPA ==="
echo

workspace="$repo/ios/App/App.xcworkspace"
if [ ! -d "$workspace" ]; then
    echo "iOS workspace not found at:" >&2
    echo "  $workspace" >&2
    echo "Run 'npm run cap:add:ios' once on this Mac to scaffold it (see" >&2
    echo "publishing/ios/README.md section 3)." >&2
    exit 1
fi

export_options="$here/ExportOptions.plist"
if [ ! -f "$export_options" ]; then
    echo "Missing $export_options" >&2
    echo "(should be committed alongside this script)" >&2
    exit 1
fi

# Resolve version from the iOS project. We trust the value the human set
# in Xcode > App target > General > Identity (MARKETING_VERSION); single
# source of truth, no duplication. Fall back to package.json if Xcode
# hasn't been touched yet.
version="$(
    cd "$repo/ios/App"
    xcodebuild -showBuildSettings -workspace App.xcworkspace -scheme App 2>/dev/null \
      | awk '/^[[:space:]]*MARKETING_VERSION = /{print $3; exit}'
)"
if [ -z "${version:-}" ]; then
    version="$(node -p "require('$repo/package.json').version" 2>/dev/null || true)"
fi
if [ -z "${version:-}" ]; then
    echo "Could not determine app version from Xcode or package.json." >&2
    exit 1
fi
echo "Version: $version"

# --- Step 1: cap sync ---
echo
echo "Building web assets and syncing Capacitor..."
( cd "$repo" && npm run cap:sync )

# --- Step 2: archive ---
archive_path="$here/chained-timers-v$version.xcarchive"
echo
echo "Archiving (xcodebuild archive)..."
echo "  Archive : $archive_path"
echo "(first run takes 3-5 min; subsequent runs are faster)"

# Discard any prior archive so xcodebuild doesn't refuse to overwrite.
rm -rf "$archive_path"

xcodebuild \
    -workspace "$workspace" \
    -scheme App \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$archive_path" \
    -allowProvisioningUpdates \
    archive

# --- Step 3: export IPA ---
export_dir="$(mktemp -d -t chained-timers-export.XXXXXX)"
trap 'rm -rf "$export_dir"' EXIT

echo
echo "Exporting IPA (xcodebuild -exportArchive)..."

xcodebuild \
    -exportArchive \
    -archivePath "$archive_path" \
    -exportOptionsPlist "$export_options" \
    -exportPath "$export_dir" \
    -allowProvisioningUpdates

# Xcode names the IPA after the scheme ("App.ipa"). Rename to a
# versioned filename next to the archive.
src_ipa="$export_dir/App.ipa"
if [ ! -f "$src_ipa" ]; then
    # Fall back to whatever .ipa landed in the export dir, in case Xcode
    # renames in a future version.
    src_ipa="$(find "$export_dir" -maxdepth 1 -name '*.ipa' -print -quit)"
fi
if [ -z "${src_ipa:-}" ] || [ ! -f "$src_ipa" ]; then
    echo "Export finished but no .ipa appeared in $export_dir" >&2
    exit 1
fi

dest_ipa="$here/chained-timers-v$version.ipa"
mv -f "$src_ipa" "$dest_ipa"

size_kb=$(( $(wc -c < "$dest_ipa") / 1024 ))
echo
echo "Done."
echo "  IPA     : $dest_ipa"
echo "  Archive : $archive_path"
echo "  Size    : ${size_kb} KB"
echo
echo "Next:"
echo "  1. Open https://appstoreconnect.apple.com (or use Transporter / Xcode Organizer)."
echo "  2. Upload the .ipa above."
echo "  3. Attach the build to the version, paste release notes, submit for review."
echo
