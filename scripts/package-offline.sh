#!/usr/bin/env bash
set -euo pipefail

# Reproducible packaging procedure for unsigned development builds.
# The .invalid domains are reserved placeholders: server/JWT mode is disabled in practice.
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="${project_dir}/downloads"

BUILD_LOGIN_URL=https://auth.example.invalid/login \
BUILD_API_BASE_URL=https://api.example.invalid/prod \
BUILD_FIREFOX_ID=aws-tag-extension@example.invalid \
node "${project_dir}/scripts/build.mjs"

mkdir -p "${release_dir}"
(
  cd "${project_dir}/dist/chrome"
  zip -q -r -X "${release_dir}/aws-tag-extension-chrome-v0.2.0-offline.zip" .
)
(
  cd "${project_dir}/dist/firefox"
  zip -q -r -X "${release_dir}/aws-tag-extension-firefox-v0.2.0-dev.zip" .
)
(
  cd "${release_dir}"
  sha256sum aws-tag-extension-chrome-v0.2.0-offline.zip \
    aws-tag-extension-firefox-v0.2.0-dev.zip > SHA256SUMS.txt
)

echo "Offline test packages created in ${release_dir}"
