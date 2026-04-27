# Publish Chained Timers to the Apple App Store

A copy-paste recipe. Total active human time: ~90 min spread across ~3 days (review wait).

> **Cost**: $99 / year for the Apple Developer Program. Stops paying = app drops from the store within ~30 days.
> **Hardware**: macOS required (Xcode runs only on Mac).
> **Outcome**: app goes live on App Store with in-place updates from this point forward.

---

## 0. Pre-flight (before you open Xcode / App Store Connect)

| What | Where it lives | You'll need it in step |
| --- | --- | --- |
| App Store icon (1024×1024) | [`icon-1024.png`](icon-1024.png) | 4.2 |
| iPhone 6.7" screenshots × 5 (1290×2796) | [`screenshots/iphone-6.7/01..05.png`](screenshots/iphone-6.7/) | 6.4 |
| Title, subtitle, description, keywords | [`store-listing.md`](store-listing.md) | 6.3 |
| App Privacy form answers | [`app-privacy.md`](app-privacy.md) | 5.4 |
| Info.plist usage descriptions | [`info-plist-additions.txt`](info-plist-additions.txt) | 4.1 |
| Privacy policy URL | <https://mayerwin.github.io/Chained-Timers/privacy.html> | 6.3 |
| Support URL | <https://github.com/mayerwin/Chained-Timers/issues> | 6.3 |
| Marketing URL (optional) | <https://mayerwin.github.io/Chained-Timers/> | 6.3 |
| Bundle identifier | `com.mayerwin.chainedtimers` (already set) | 5.2 |

---

## 1. Apple Developer Program ($99/year)

> **One-time signup, ~24-48h identity verification wait.**

1. Go to <https://developer.apple.com/programs/enroll/>.
2. Sign in with the Apple ID you want associated with the developer account.
3. Choose **Individual** (or Organization if you have a D-U-N-S number).
4. Pay **$99**. Apple emails when verified — usually within 48 hours.

While you wait, you can do steps 2–3 below.

---

## 2. Install the macOS toolchain (one-time, ~30 min)

On your Mac:

1. Install Xcode from the App Store (latest version, ~10 GB download).
2. Launch Xcode once to accept the license. Sign in with your Apple ID under **Xcode → Settings → Accounts**.
3. Install Command Line Tools: `xcode-select --install` in Terminal.
4. Install CocoaPods: `sudo gem install cocoapods` (uses macOS's built-in Ruby).

Verify: `pod --version` should print `1.x.x`.

---

## 3. Scaffold the iOS project (one-time, ~3 min)

```bash
git clone https://github.com/mayerwin/Chained-Timers.git
cd Chained-Timers
npm install
npm run cap:add:ios       # generates ios/ folder, runs pod install
git add ios/
git commit -m "Add iOS Capacitor project skeleton"
git push
```

The `ios/` folder is now part of the repo. Subsequent builds reuse it — no need to re-scaffold.

---

## 4. Open Xcode and configure signing (one-time, ~15 min)

```bash
npm run cap:ios           # builds dist/, syncs Capacitor, opens Xcode
```

In Xcode:

### 4.1 Add Info.plist usage descriptions

Open `ios/App/App/Info.plist` (right-click → Open As → Source Code).

Paste the contents of [`info-plist-additions.txt`](info-plist-additions.txt) inside the top-level `<dict>`, just before the closing `</dict>` tag.

> Without these, iOS will reject permission prompts at runtime and App Review will reject the submission.

### 4.2 Add the App Store icon

In Xcode's Project Navigator (left sidebar): `App → App → Assets.xcassets → AppIcon`.

Drag-and-drop [`icon-1024.png`](icon-1024.png) onto the **App Store iOS** 1024×1024 slot. Xcode 14+ auto-derives every smaller size you need (no manual resizing).

### 4.3 Sign the app

1. Click the **App** target (top of Project Navigator).
2. **Signing & Capabilities** tab.
3. Tick **Automatically manage signing**.
4. **Team**: select your paid Apple Developer team from the dropdown.
5. **Bundle Identifier**: `com.mayerwin.chainedtimers`. If Xcode says "this identifier is already registered to another team," it means someone else owns it — change it to e.g. `com.<yourname>.chainedtimers` and update `capacitor.config.json`'s `appId` to match, then run `npm run cap:sync` again.

Xcode will provision the signing certificates automatically. If it complains, click **Try Again** — usually a transient cert-fetch issue.

### 4.4 Verify the build runs

- Plug in your iPhone (or use a simulator: **Product → Destination → iPhone 16 Pro Max**).
- **Product → Run** (⌘R). The app should launch and show the library view.
- Test the **Test in 10s** button under Settings → Native bridge to confirm notifications work.

---

## 5. App Store Connect setup (~15 min)

### 5.1 Open App Store Connect
- Go to <https://appstoreconnect.apple.com>. Sign in with your Apple Developer Apple ID.

### 5.2 Register the app
- **My Apps → +** (top-left) → **New App**.
- **Platform**: iOS
- **Name**: `Chained Timers` (this becomes the App Store listing title)
- **Primary language**: English (U.S.)
- **Bundle ID**: select `com.mayerwin.chainedtimers` from the dropdown (it appears once Xcode has registered an explicit App ID, which it does automatically when you build).
  - If it doesn't appear, go to <https://developer.apple.com/account/resources/identifiers/list> → **+** → App IDs → App → name "Chained Timers", bundle ID `com.mayerwin.chainedtimers` (Explicit), enable Capabilities: **Push Notifications** is NOT needed (we use local notifications). Save.
- **SKU**: `chained-timers-v1` (internal identifier, never shown to users)
- **User Access**: Full Access (default)
- Click **Create**.

### 5.3 App Information section
Left sidebar → **App Information**.

- **Subtitle**: paste from [`store-listing.md`](store-listing.md) §"Subtitle"
- **Privacy Policy URL**: <https://mayerwin.github.io/Chained-Timers/privacy.html>
- **Category**:
  - Primary: **Health & Fitness**
  - Secondary: **Productivity**
- **Content Rights**: **No, this app does not contain, show, or access third-party content** (we use Google Fonts on the web version only, but the native app bundles fonts — answer applies to the native app only).
- **Age Rating**: click **Edit**, fill the questionnaire (all answers **None**), save → result **4+**.
- **Save**.

### 5.4 App Privacy section
Left sidebar → **App Privacy**.

- Open [`app-privacy.md`](app-privacy.md) and follow the answers.
- Result: **No data collected. No data linked to you. No data used to track you.**
- Click **Publish**.

### 5.5 Pricing and Availability
Left sidebar → **Pricing and Availability**.

- **Price**: Free (USD 0.00)
- **Availability**: All countries / regions (or restrict if you want).
- **App Store Distribution**: Available on the App Store.

---

## 6. Prepare the version listing (~10 min)

Left sidebar → **iOS App → 1.0 Prepare for Submission**.

### 6.1 Version
- **Version**: `1.0.0` (matches the `MARKETING_VERSION` in Xcode).

### 6.2 Build (we'll attach this in step 7 after archiving)
Skip for now.

### 6.3 What to Test (TestFlight only — leave blank for App Store submission)

### 6.4 Promotional Text (170 chars max, can change without resubmission)
Paste from [`store-listing.md`](store-listing.md) §"Promotional text".

### 6.5 Description (4000 chars max)
Paste from [`store-listing.md`](store-listing.md) §"Description".

### 6.6 Keywords (100 chars max, comma-separated)
Paste from [`store-listing.md`](store-listing.md) §"Keywords".

### 6.7 Support URL
<https://github.com/mayerwin/Chained-Timers/issues>

### 6.8 Marketing URL (optional)
<https://mayerwin.github.io/Chained-Timers/>

### 6.9 Screenshots
Scroll to the **App Previews and Screenshots** section.

- **iPhone 6.7" Display**: drag-and-drop in this order:
  - [`screenshots/iphone-6.7/01-library.png`](screenshots/iphone-6.7/)
  - [`screenshots/iphone-6.7/02-editor.png`](screenshots/iphone-6.7/)
  - [`screenshots/iphone-6.7/03-templates.png`](screenshots/iphone-6.7/)
  - [`screenshots/iphone-6.7/04-run.png`](screenshots/iphone-6.7/)
  - [`screenshots/iphone-6.7/05-settings.png`](screenshots/iphone-6.7/)

> If Apple's UI insists on more device sizes (5.5" Display): screenshots from a smaller iPhone are auto-derived from the 6.7" set if you only upload there. Or take 5.5" screenshots by adding the profile to `tools/store-screenshots.mjs` (viewport 414×736, deviceScaleFactor 3 → 1242×2208).

### 6.10 General App Information
- **App Icon**: already attached via Xcode (step 4.2). App Store Connect pulls it from the build automatically.
- **Copyright**: `© 2026 Erwin Mayer` (or your name).
- **Routing App Coverage File**: leave blank (not a routing/maps app).
- **Sign-In Information**: leave blank (no login required).

### 6.11 Version Release
Choose one:
- **Manually release this version** (recommended for first launch — gives you control over the moment it goes live)
- **Automatically release this version** (goes live the moment Apple approves)

### 6.12 What's New in This Version (release notes — 4000 chars, must change every version)
Paste from [`store-listing.md`](store-listing.md) §"What's new in v1.0.0".

---

## 7. Archive & upload the build (~10 min)

In Xcode:

### 7.1 Build settings
1. Top toolbar: change **Destination** to **Any iOS Device (arm64)**.
2. **App** target → **General** → **Identity**:
   - **Display Name**: Chained Timers
   - **Bundle Identifier**: com.mayerwin.chainedtimers
   - **Version**: 1.0.0
   - **Build**: 1 (must be a unique increasing number for each upload — bump to 2, 3, ... for subsequent uploads of the same version)

### 7.2 Archive
- **Product → Archive**.
- Wait ~3-5 min for the archive to build. The Organizer window opens automatically when done.

### 7.3 Validate (optional but recommended)
- In the Organizer, select the new archive → **Validate App**.
- Distribution method: **App Store Connect**. Click through the prompts (use automatic signing).
- Validation runs ~1-2 min. If errors appear, fix them and re-archive.

### 7.4 Distribute
- **Distribute App** → **App Store Connect** → **Upload**.
- Click through the prompts (use automatic signing).
- Upload takes 5-15 min depending on connection. When done, Apple processes the build for ~10-30 min.

### 7.5 Attach the build to the version
- Back in App Store Connect → **iOS App → 1.0 Prepare for Submission**.
- Scroll to **Build** section. Click **Select a build before you submit your app**.
- Pick the build you just uploaded (it appears once Apple finishes processing — refresh after ~15 min if not visible).
- **Save**.

### 7.6 Export Compliance
- Asked once after attaching the build.
- **Does your app use encryption?**
  - If asked → choose: **No** if you only use HTTPS/TLS for fonts (built-in OS encryption is exempt).
  - The Capacitor framework itself doesn't add additional encryption.
- → **No proprietary cryptography** (we use no custom crypto).
- This sets `ITSAppUsesNonExemptEncryption = NO` automatically. Apple may ask you to add the key to Info.plist explicitly — if so:

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

---

## 8. Submit for review

- **Submit for Review** button at the top of the version page.
- A short questionnaire pops up:
  - Advertising Identifier (IDFA) → **No**, we don't use it.
- Click **Submit**.

### 8.1 Review timing
- **First-time review**: 1-3 days typically. Sometimes within hours, sometimes up to a week.
- Subsequent updates: usually <24 hours.
- Track status in App Store Connect → **My Apps → Chained Timers → Activity**.

### 8.2 If rejected
- Apple emails the reason. Common ones for our app:
  - **2.5.1 Background modes misuse**: only if you ticked "Audio" in Background Modes for the silent-audio keep-alive trick. Solution: untick that capability, document the iOS limit honestly. The app already does this in the in-app iOS notice.
  - **5.1.1 Privacy policy missing or unclear**: shouldn't happen — our policy is at <https://mayerwin.github.io/Chained-Timers/privacy.html> and is verbatim "we collect nothing." Re-confirm the URL is correct.
- Reply via the Resolution Center with the fix; usually re-reviewed within 24h.

### 8.3 If approved with manual release
- Click **Release This Version** to push it live.
- Listing URL: `https://apps.apple.com/app/chained-timers/idXXXXXXXXX` (Apple assigns the numeric ID).

---

## 9. TestFlight (optional but very recommended)

While the App Store review takes 1-3 days, **TestFlight** lets you install builds on real devices immediately.

1. After uploading a build (step 7), it appears in App Store Connect → **TestFlight** tab.
2. Add **Internal Testers** (your Apple Developer team members — up to 100).
3. Optionally invite up to 10 000 **External Testers** (requires a quick Apple review of the test build, ~24h).
4. Testers install the **TestFlight** app on their iPhone and join via the invitation link or code.
5. TestFlight builds expire 90 days after upload.

Useful for catching bugs before App Store submission.

---

## 10. Future updates (after the first release is live)

```bash
# 1. Bump versions
#    Xcode → App target → General → Identity:
#      Version (MARKETING_VERSION): 1.0.1
#      Build   (CURRENT_PROJECT_VERSION): 2  (must increase each upload)
#    package.json: "version": "1.0.1"
#    (also bump Android — see ../android/README.md)

# 2. Refresh publishing assets if UI changed
npm run serve &
npm run screenshots:store
npm run publishing:refresh

# 3. Build a new archive and upload (Xcode: Product → Archive → Distribute → App Store Connect)

# 4. Tag the release (triggers GitHub-Releases sideload APK build)
git tag v1.0.1 && git push --tags

# 5. In App Store Connect:
#    iOS App → + Version → 1.0.1
#    Update "What's new in v1.0.1" from store-listing.md
#    Attach the new build, submit for review.
```

Updates with no new permissions usually clear review in <24h.
