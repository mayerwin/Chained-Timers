# =====================================================================
# Build + upload the Play Store AAB to ALL tracks, including production.
#
# Thin wrapper over 4-publish-to-play.ps1 -- just adds `production` to
# the track list. The same AAB lands on internal, closed testing, and
# production simultaneously: upload once via publishBundle, copy to the
# remaining tracks via promoteArtifact.
#
# Heads-up: Google Play won't accept a production release until you've
# satisfied their pre-launch requirements (currently, for a new
# individual developer account, that means 12+ closed-testing testers
# active for 14+ days). If those aren't met, the production-promotion
# step fails with a clear error from the API and the upload to internal
# + closed-testing remains in place.
#
# Override release status the same way as for 4-publish-to-play.ps1:
#   $env:PLAY_RELEASE_STATUS = 'draft'        # land prod in draft
# =====================================================================

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$env:PLAY_TRACKS = 'internal,alpha,production'

& (Join-Path $here '4-publish-to-play.ps1')
exit $LASTEXITCODE
