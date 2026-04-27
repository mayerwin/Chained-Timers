# Publishing assets

Everything needed to publish Chained Timers to the **Google Play Store** and the **Apple App Store**, organised so the human steps are reduced to *click → upload file → paste text*. No content writing, no icon resizing, no screenshot capturing.

```
publishing/
├── README.md             ← you are here (index + future-agent guide)
├── secrets.template.md   ← what secrets you need + how to store them (no secrets in git)
├── secrets.local.md      ← gitignored — your filled-in copy lives here
├── android/              ← Play Store assets + step-by-step recipe
└── ios/                  ← App Store  assets + step-by-step recipe
```

## How to publish — start here

| If your goal is | Open |
| --- | --- |
| Publish to **Google Play Store** | [`publishing/android/README.md`](android/README.md) |
| Publish to **Apple App Store**   | [`publishing/ios/README.md`](ios/README.md) |
| Just sideload-distribute the APK | already done — see [GitHub Releases](https://github.com/mayerwin/Chained-Timers/releases) |

Each platform's README is a numbered checklist. Every step says *exactly* which file to upload or which text to paste from the surrounding folder.

---

## What's pre-generated for you

### Common to both stores

| Asset | Path | Notes |
| --- | --- | --- |
| Privacy policy | hosted at <https://mayerwin.github.io/Chained-Timers/privacy.html>, source [`privacy.html`](../privacy.html) | required URL on both stores |
| Support URL | <https://github.com/mayerwin/Chained-Timers/issues> | required URL on both stores |
| Marketing URL | <https://mayerwin.github.io/Chained-Timers/> | optional, recommended |

### Android (Play Store) — [`publishing/android/`](android/)

| Asset | Path |
| --- | --- |
| App icon (512×512) | [`android/icon-512.png`](android/icon-512.png) |
| Feature graphic (1024×500) | [`android/feature-graphic-1024x500.png`](android/feature-graphic-1024x500.png) |
| Phone screenshots (1080×1920) × 5 | [`android/screenshots/01..05.png`](android/screenshots/) |
| Store listing (title, descriptions) | [`android/store-listing.md`](android/store-listing.md) |
| Data safety form answers | [`android/data-safety.md`](android/data-safety.md) |
| Content rating questionnaire answers | [`android/content-rating.md`](android/content-rating.md) |
| `USE_EXACT_ALARM` permission declaration | [`android/permissions-declaration.md`](android/permissions-declaration.md) |
| AAB build instructions | [`android/README.md`](android/README.md) §3 |

### iOS (App Store) — [`publishing/ios/`](ios/)

| Asset | Path |
| --- | --- |
| App Store icon (1024×1024) | [`ios/icon-1024.png`](ios/icon-1024.png) |
| iPhone 6.7" screenshots (1290×2796) × 5 | [`ios/screenshots/iphone-6.7/01..05.png`](ios/screenshots/iphone-6.7/) |
| Store listing (title, subtitle, descriptions, keywords) | [`ios/store-listing.md`](ios/store-listing.md) |
| App Privacy questionnaire answers | [`ios/app-privacy.md`](ios/app-privacy.md) |
| Info.plist additions | [`ios/info-plist-additions.txt`](ios/info-plist-additions.txt) |
| Xcode build & upload instructions | [`ios/README.md`](ios/README.md) §3 |

---

## Regenerate the assets when a new release ships

When you tag a new version (e.g. `v1.1.0`), the screenshots and the version-specific copy in the listings should be refreshed. The icon and the feature graphic don't change unless you redesign the brand.

```bash
# 1. Regenerate icons + feature graphic from the SVG masters in icons/
npm run icons

# 2. Regenerate store screenshots at the exact dimensions both stores want.
#    Requires the dev server running (in another terminal: npm run serve).
npm run screenshots:store

# 3. Copy the freshly-generated asset files into publishing/ (one-shot script)
npm run publishing:refresh
```

After this, manually:

1. Update the `## What's new in vX.Y.Z` section of [`android/store-listing.md`](android/store-listing.md) and [`ios/store-listing.md`](ios/store-listing.md). Both stores have a *Release notes* / *What's New* field, capped at 500 chars each — keep it tight.
2. Bump version numbers (see [`PUBLISHING.md`](../PUBLISHING.md) §"Maintaining both at once").
3. Re-upload asset files via the Play Console / App Store Connect web UI. Each platform's README has the screen-by-screen path.

---

## For future agents working in this repo

If you're an AI agent (Claude, Codex, etc.) asked to "publish a new release" or "update the publishing assets", here is the contract:

### When the user tags a new version

1. **Icons and feature graphic** rarely change. Only regenerate if the SVG masters in `icons/` were updated (look at `git diff icons/`). Otherwise leave them.
2. **Screenshots SHOULD be regenerated** for any release that changes the UI of the screens captured (library, editor, templates, run mode, settings). To check:

   ```bash
   git diff <previous-tag> HEAD -- index.html css/styles.css js/app.js
   ```

   If non-trivial UI changes appear, refresh screenshots:

   ```bash
   npm run serve &           # background dev server
   npm run screenshots:store
   npm run publishing:refresh
   ```

3. **Store-listing copy** (`store-listing.md` in both folders) should reflect new features. Look at the commits between the previous tag and HEAD; if user-visible features were added, mention them in the *What's new* section. Keep ≤500 chars.

4. **Permissions** — the lists in [`android/permissions-declaration.md`](android/permissions-declaration.md) and [`ios/info-plist-additions.txt`](ios/info-plist-additions.txt) reflect what the app actually requests. Cross-check against `android/app/src/main/AndroidManifest.xml` after every release. If a new permission was added, document its justification in the relevant file.

5. **Privacy policy** — only update if the app's data behaviour genuinely changed. Bump the version number and the *Last updated* date in [`privacy.html`](../privacy.html). Do **not** invent collected data — the app collects nothing and that's a shipping promise.

6. **Commit message** for publishing-asset refreshes:

   ```
   publishing: refresh assets for vX.Y.Z

   - Regenerated screenshots (UI changes in commits …)
   - Updated store-listing.md "What's new" section
   - [any other changes]
   ```

7. **Do not commit any keystore, certificate, or password.** The `secrets.local.md` and `*.keystore` patterns in `.gitignore` enforce this. If you find yourself about to write a secret to a tracked file, stop and put it in `secrets.local.md` instead.

### When the user asks "submit to the store"

You can't — submission requires a logged-in human session in the Play Console and App Store Connect web UIs (and, for iOS, a macOS machine running Xcode). Your role is to produce assets and metadata that make the human's job a copy/paste exercise. The platform READMEs explicitly call out which steps are human-only.

---

## Status

- ✅ Privacy policy hosted at <https://mayerwin.github.io/Chained-Timers/privacy.html>
- ✅ All Android Play Store assets generated and documented
- ✅ All Apple App Store assets generated and documented (excluding iOS native build, which requires `npm run cap:add:ios` on a macOS machine — see [`ios/README.md`](ios/README.md))
- ❌ Play Console developer account (one-time $25, human action required)
- ❌ Apple Developer Program membership ($99/yr, human action required)
- ❌ Initial submission to either store (human action required)

Sideload distribution at <https://github.com/mayerwin/Chained-Timers/releases> remains free and instant.
