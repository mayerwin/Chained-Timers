# Publishing to the Play Store and the App Store

This document is the complete checklist + recipes to take Chained Timers from
its current sideload state to the two major commercial app stores. It assumes
you're starting from a fresh clone of this repository on a development machine.

> **Why is this not already done?** Sideload distribution costs $0 and needs no
> external account. Store distribution requires paid developer accounts and a
> non-trivial amount of metadata work that pays off only if you intend to
> publicly distribute. The PWA at <https://mayerwin.github.io/Chained-Timers/>
> is free for anyone to use today and the Android APK on the
> [Releases page](https://github.com/mayerwin/Chained-Timers/releases) is one
> click away on Android.

---

## Cost summary

| Store | Account fee | Revenue share | Annual obligation |
| --- | --- | --- | --- |
| **Google Play** | **$25** one-time, lifetime developer account | 15 % first $1M / yr, 30 % above | None — apps stay published indefinitely once uploaded, even at $0 revenue. |
| **Apple App Store** | **$99 / year** (Apple Developer Program) | 15 % small-business / 30 % standard | Yearly renewal — if you stop paying, your apps disappear from the store within ~30 days. |

For a free no-revenue app the math is: $25 once for Android, ~$99/yr forever for iOS.

---

## Material you need for *both* stores (do this once)

### 1. Privacy policy (mandatory on both)

Both stores require a publicly-hosted URL containing a privacy policy.
Chained Timers does not collect, transmit or sync any user data — chains and
settings live entirely in the browser's `localStorage` / native
`Preferences` plugin storage. Even so, a "we collect nothing" policy must be
written and hosted.

Quick options:

- **GitHub Pages page** in this repo: this is what we ship — the file at [`privacy.html`](privacy.html) is served by GitHub Pages at
  <https://mayerwin.github.io/Chained-Timers/privacy.html>. Edit there if you ever need to update.
- **Free generators**: <https://www.freeprivacypolicy.com/>,
  <https://app-privacy-policy-generator.firebaseapp.com/>.

Minimum content (literal text usable as-is):

```
Chained Timers Privacy Policy
Last updated: <date>

Chained Timers does not collect, store, transmit or share any personal data.

All chains, settings and history are stored locally on your device using the
operating system's local storage. Nothing is uploaded to any server. The app
makes no network requests in normal operation other than (a) loading the web
fonts on the public website version, and (b) on first install, downloading
the static assets from the app bundle.

Permissions we request:
- POST_NOTIFICATIONS / Notifications: to display the segment-transition
  alerts you've configured.
- USE_EXACT_ALARM / SCHEDULE_EXACT_ALARM (Android): to schedule those
  notifications at the exact times required by your timer chains.
- VIBRATE (Android) / Haptic feedback (iOS): to vibrate the device at
  segment transitions if enabled.
- WAKE_LOCK (Android) / Idle Timer Disabled (iOS): to keep the screen
  awake during a chain, if you enable that setting.

We have no analytics SDK, no crash reporter, no ads, no third-party
trackers, no remote config, and no account system.

For questions, open an issue at https://github.com/mayerwin/Chained-Timers
```

### 2. Support URL

A public page where users can reach you. The repo's GitHub Issues page
(`https://github.com/mayerwin/Chained-Timers/issues`) is sufficient.

### 3. Marketing URL (optional but recommended)

The PWA itself works fine: `https://mayerwin.github.io/Chained-Timers/`

### 4. App icon — already done

[`icons/icon-512.png`](icons/icon-512.png) (PWA / generic),
[`icons/icon-maskable-512.png`](icons/icon-maskable-512.png) (Android adaptive).
Stores want various sizes — both Android Studio's *Image Asset Studio* and
Xcode's *AppIcon* asset catalog can autogenerate everything from the 512×512.

### 5. Screenshots

The repo already ships three at `docs/screenshots/`. Stores require more:

- **Play Store**: minimum 2, up to 8 phone screenshots, plus optional 7"/10" tablet sets.
- **App Store**: required for at least one device size — currently iPhone 6.7" (Pro Max). Optional for other sizes; if absent, Apple uses the largest provided. Up to 10 per device.

Generate them with Playwright:

```bash
npm run smoke
# Outputs to ./screenshots/, in 390×844 (iPhone 14) viewport.
# Re-run with different viewports for tablet sets if needed.
```

For App Store iPhone 6.7" you need 1290×2796 — adjust `tools/smoke.mjs`'s
`VP` constant or take screenshots inside Xcode's iPhone simulator.

### 6. Feature graphic (Play Store only)

1024×500 PNG, no transparency, displayed at the top of the Play listing.
Reuse / extend [`icons/social-card.png`](icons/social-card.png) (1200×630 →
crop to 1024×500). Or regenerate via `tools/generate-icons.mjs`.

### 7. App description text

Copy from the `README.md` lead section, or use this draft:

```
Title: Chained Timers
Subtitle: Interval chains for sport & focus
Short description (Play, 80 chars max):
  Sequence intervals into named chains. Vibrates and notifies between segments.
Full description (4000 chars max):
  Chained Timers is a small, focused interval-timer app for sport, breathwork,
  cooking, and study. Instead of juggling three separate timers, you build a
  named "chain" once — a sequence of segments with their own durations and
  colors — and the app fires the next one automatically when the previous
  ends. Vibration, sound, and a system notification mark every transition.

  Chains can embed other chains. Build a "Full Workout" chain that nests your
  saved "Plank Stack" between a warmup and a cooldown — edit the inner chain
  and every parent updates automatically.

  Designed for the moment your hands are busy. The cinematic run mode shows
  the segment name in display type, the remaining time in tabular numerals,
  and a progression strip showing your position in the chain. A pre-start
  countdown, a final-3-second tick, and big controls for sweaty thumbs.

  Built-in templates: Tabata, EMOM, Boxing Rounds, Pomodoro, Plank Stack,
  Box Breath. Tap to fork into your library.

  No account. No tracking. No ads. Your library lives on your device.

Keywords (App Store, 100 chars max comma-separated):
  timer,interval,workout,hiit,tabata,plank,pomodoro,breath,boxing,emom
Category: Health & Fitness (primary) — Productivity (secondary, App Store only)
Content rating: Everyone (Play) / 4+ (App Store)
```

### 8. Legal screenshots & metadata

- No alcohol, gambling, or 18+ content → simple ratings.
- Play Store: complete the *Content rating questionnaire* (~5 min, automated).
- App Store: complete *App Privacy* questions (answer "No data collected" for everything).

---

## Google Play Store

### Prerequisites

```bash
# 1. Sign up: https://play.google.com/console/signup
#    Pay $25 one-time. Identity verification can take up to 48h.
#
# 2. Verified developer profile (since 2023): D-U-N-S number, address.
#    Personal account: address shown publicly on the listing.
#    Organisation: requires a D-U-N-S (free at https://www.dnb.com/ ).
#
# 3. Tax & banking info (only required if you charge for the app or run
#    in-app purchases — skip for free apps).
```

### One-time keystore for Play (NOT the sideload keystore)

The Play Store uses a different signing model — *Play App Signing*. You upload
an **upload key** (which you keep), and Google manages a separate **app signing
key** for distribution. The sideload keystore in this repo is intentionally
public, so it must NOT be used for the Play upload key.

```bash
# Generate a private upload keystore (DO NOT commit)
keytool -genkey -v -keystore upload.keystore \
  -alias chainedtimers-upload -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=<your name>, O=<your org>, L=<city>, S=<state>, C=<country>"

# Store password and key password in a private file
cat > android/keystore.properties <<EOF
storeFile=../upload.keystore
storePassword=<password>
keyAlias=chainedtimers-upload
keyPassword=<password>
EOF

# upload.keystore and keystore.properties are already in .gitignore
```

Then add a *new* signing config for Play to `android/app/build.gradle` (do not
remove the `sideload` config — sideload distribution still uses it):

```gradle
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        sideload { /* existing block */ }
        play {
            if (keystoreProperties['storeFile']) {
                storeFile     file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias      keystoreProperties['keyAlias']
                keyPassword   keystoreProperties['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.play   // ← swap from sideload
            minifyEnabled true                  // shrink for Play
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

### Build the AAB (Play Store wants Android App Bundles, not APKs)

```bash
npm run build:www
npx cap sync android
cd android
./gradlew bundleRelease
# Output: android/app/build/outputs/bundle/release/app-release.aab
```

### Upload flow

1. Open the [Play Console](https://play.google.com/console).
2. Create app → Name, language, free/paid, declarations.
3. **Set up your app** (left sidebar): work top to bottom. Each row is mandatory.
   - App access (no login required → "All functionality available without restrictions").
   - Ads (no).
   - Content rating (questionnaire).
   - Target audience (13+ recommended; the app is fine for all ages).
   - News app (no).
   - COVID-19 contact tracing (no).
   - Data safety (no data collected — every checkbox "no").
   - Government apps (no).
   - Financial features (no).
4. **Store listing**:
   - App name: Chained Timers
   - Short description, full description (see above).
   - App icon (512×512).
   - Feature graphic (1024×500).
   - Phone screenshots (≥2).
   - Category: Health & Fitness.
   - Contact email, website, privacy policy URL.
5. **Production / Internal testing release**: upload the `.aab`, fill release notes, submit for review. **First-time review takes ~7 days**; subsequent updates usually <2 days.

### Updates after launch

Bump `versionCode` (must increase) and `versionName` in `android/app/build.gradle`, rebuild the AAB, upload via *Production → Create new release* in the console.

### Things that will trip you up

- **`USE_EXACT_ALARM` is restricted by Play Store policy** — only allowed for apps where exact alarms are central (alarm clocks, timers, calendars, ride-sharing). Chained Timers qualifies as a timer app, but you'll need to declare the use case in the *Permissions declaration form* during submission.
- **`SCHEDULE_EXACT_ALARM`** without `USE_EXACT_ALARM` is more strictly gated; declare both, document use case as "calendar/alarm".
- Play requires **target SDK** to be no more than 1 year behind the latest. We're on 36 (Android 16), so safe through 2027.

---

## Apple App Store

### Prerequisites

```bash
# 1. macOS — Xcode only runs on Mac. No way around this for iOS publishing.
#    Hardware: Intel or Apple Silicon Mac, macOS 14 (Sonoma) minimum.
#
# 2. Apple Developer Program: https://developer.apple.com/programs/
#    $99/year. Personal Apple ID required. Identity verification ~24-48h.
#
# 3. Install: Xcode (latest from App Store) + Command Line Tools.
#    Cocoapods: `sudo gem install cocoapods` (Ruby is shipped with macOS).
```

### Scaffold the iOS project (one-time on a Mac)

```bash
git clone https://github.com/mayerwin/Chained-Timers.git
cd Chained-Timers
npm install
npm run cap:add:ios       # generates the ios/ folder + runs pod install
```

This creates `ios/App/App.xcworkspace`. Commit the `ios/` folder so future
builds don't have to re-scaffold.

### Open the project in Xcode

```bash
npm run cap:ios           # builds dist/, runs cap sync, opens Xcode
```

In Xcode:

1. Select the **App** target → **Signing & Capabilities**.
2. **Team**: select your paid Apple Developer team. Check **Automatically manage signing**.
3. **Bundle Identifier**: `com.mayerwin.chainedtimers` (already set in `capacitor.config.json`). Apple requires this to be unique across the App Store — if taken, change to e.g. `com.<yourname>.chainedtimers` and update `capacitor.config.json` to match.
4. **Capabilities** (click + Capability):
   - *Background Modes* → tick *Audio, AirPlay, and Picture in Picture* if you want the silent-audio keep-alive trick to work on iOS (controversial, may trip App Review — see *Common reviewer rejections* below).
   - *Push Notifications* — NOT needed (we use local notifications).

### App icons & launch screen

- Drop a **1024×1024** PNG into `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`. Xcode 14+ auto-derives all other sizes.
- Launch screen: `ios/App/App/App/Base.lproj/LaunchScreen.storyboard`. Capacitor scaffolds a basic one — customize the background colour to match `#0E0D0B` and place the icon centered.

### Info.plist additions for permissions

Edit `ios/App/App/Info.plist` and add these usage descriptions (required by Apple — without them the OS crashes the app on first permission prompt):

```xml
<key>NSUserNotificationsUsageDescription</key>
<string>Chained Timers schedules notifications so segment transitions fire even when the app is backgrounded or the screen is locked.</string>
```

(`NSUserNotificationsUsageDescription` is technically optional for `UNUserNotificationCenter` but App Review checks for one. Add it.)

### Build an archive

In Xcode: **Product → Archive** (this auto-runs `cap sync` if Build Phases are configured by Capacitor; if not, run `npm run cap:sync` manually before archiving).

When the Archive completes, the **Organizer** window opens.

### Distribute via App Store Connect

1. In Organizer: select the archive → **Distribute App** → **App Store Connect** → **Upload**. Xcode handles signing automatically.
2. Open <https://appstoreconnect.apple.com>, **My Apps → +** → register `com.mayerwin.chainedtimers`.
3. Fill out the listing:
   - Name, subtitle (30 chars), description, keywords, support URL, marketing URL, privacy policy URL.
   - Screenshots: at minimum, **iPhone 6.7"** (1290×2796). Add **iPhone 5.5"** (1242×2208) for older device coverage.
   - Pricing: Free.
   - App Privacy → "I don't collect data from this app".
   - Age rating: 4+ (no objectionable content).
4. **Build**: select the archive you uploaded.
5. **Submit for review**.

### TestFlight (optional but recommended)

While the App Store review takes 1-3 days, **TestFlight** lets you install builds on real devices immediately (up to 10,000 testers, 90-day expiry per build).

In App Store Connect → **TestFlight** → add internal testers (your own Apple ID / dev team) → install via the TestFlight app on your iPhone.

### Common reviewer rejections to pre-empt

- **3.1.1 In-App Purchase**: doesn't apply, app is fully free.
- **2.5.1 Background modes**: if you tick *Audio* in Background Modes for the silent-audio keep-alive trick, Apple may reject under "App is using the audio background mode for a non-audio purpose." Options: (a) remove the silent-audio trick and document the limit honestly; (b) re-frame as "play meditative tones during breathwork chains" if you actually add a tone generator. The honest path is (a).
- **4.0 Design**: Apple expects the app to feel native. The PWA does — Editorial Athletic Brutalism aesthetic + tabular numerals + system fonts as fallback all read as deliberate design choices, not lazy web ports.
- **5.1.1 Privacy**: missing or vague privacy policy. Use the text above verbatim — it's bulletproof because we genuinely collect nothing.

### Updates after launch

Bump `MARKETING_VERSION` (semver, e.g. 1.0.1) and `CURRENT_PROJECT_VERSION` (monotonic build number) in Xcode → App target → **General → Identity**. Re-archive, upload, submit. Updates usually clear review in <24h.

---

## Maintaining both at once

Once both are live, the unified release flow per version:

```bash
# 1. Bump versions in three places
#    - package.json                "version": "1.0.1"
#    - android/app/build.gradle    versionCode 2, versionName "1.0.1"
#    - ios/App/App.xcodeproj       MARKETING_VERSION = 1.0.1, CURRENT_PROJECT_VERSION = 2

# 2. Tag and push — CI builds the sideload APK and attaches to GitHub Release
git tag v1.0.1
git push --tags

# 3. Build the Play AAB locally
cd android && ./gradlew bundleRelease
# Upload android/app/build/outputs/bundle/release/app-release.aab to Play Console

# 4. Build the iOS Archive in Xcode → upload to App Store Connect

# 5. Submit both for review.
```

You can automate steps 3 & 4 in CI, but Play upload requires a service-account JSON and App Store Connect upload requires an app-specific password — both are private secrets that should live in GitHub Actions secrets, not the repo.

---

## What's currently in the repo (state-of-play)

- ✅ Sideload APK signed with stable keystore (no Play key yet)
- ✅ AndroidManifest declares `USE_EXACT_ALARM` + `SCHEDULE_EXACT_ALARM` (Play permission declaration form will be needed)
- ✅ `applicationId` / `bundleId` set to `com.mayerwin.chainedtimers` for both
- ✅ Privacy policy text drafted in this document (not yet hosted)
- ✅ Icons rendered at all PWA / Android launcher densities
- ✅ Web app + screenshots ready as marketing material
- ❌ Play Console developer account (one-time $25)
- ❌ Apple Developer Program membership ($99/yr)
- ❌ iOS project scaffolded (`npm run cap:add:ios` on a Mac)
- ❌ Privacy policy hosted at a public URL
- ❌ Play upload keystore generated & configured
- ❌ App Store Connect / Play Console store listings filled

The sideload distribution path remains fully functional with zero external dependencies.
