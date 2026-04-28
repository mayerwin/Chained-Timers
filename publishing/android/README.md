# Publish Chained Timers to the Google Play Store

A copy-paste recipe. Total active human time: ~45 min spread across ~10 days (review wait).

> **Cost**: $25, one-time, lifetime developer account. No revenue share applies because the app is free.
> **Outcome**: app goes live on Play Store with in-place updates from this point forward.

---

## 0. Pre-flight (before you open the Play Console)

| What | Where it lives | You'll need it in step |
| --- | --- | --- |
| App icon (512×512) | [`icon-512.png`](icon-512.png) | 5.4 |
| Feature graphic (1024×500) | [`feature-graphic-1024x500.png`](feature-graphic-1024x500.png) | 5.4 |
| Phone screenshots × 5 (1080×1920) | [`screenshots/01..05.png`](screenshots/) | 5.4 |
| Title, descriptions, keywords | [`store-listing.md`](store-listing.md) | 5.3 |
| Data safety form answers | [`data-safety.md`](data-safety.md) | 4.5 |
| Content rating answers | [`content-rating.md`](content-rating.md) | 4.4 |
| `USE_EXACT_ALARM` justification | [`permissions-declaration.md`](permissions-declaration.md) | 6.3 |
| Privacy policy URL | <https://mayerwin.github.io/Chained-Timers/privacy.html> | 5.3 |
| Support URL | <https://github.com/mayerwin/Chained-Timers/issues> | 5.3 |
| Marketing URL (optional) | <https://mayerwin.github.io/Chained-Timers/> | 5.3 |
| Upload keystore (you'll generate in step 2) | `upload.keystore` at repo root (gitignored) | 3 |

---

## 1. Open a Play Console developer account ($25, one-time)

> **One-time, ~24-48h identity verification wait.**

1. Go to <https://play.google.com/console/signup>.
2. Choose **Personal account** (or Organisation if you have a D-U-N-S number).
3. Pay the **$25 one-time fee**.
4. Complete identity verification (upload ID, address proof). Google emails when approved — usually within 48 hours.

While you wait, you can do steps 2 and 3 below.

---

## 2. Generate the Play upload keystore (one-time, ~2 min)

The sideload keystore in `android/sideload.keystore` is committed publicly and **must not** be used for the Play Store.

**Double-click [`1-generate-upload-keystore.bat`](1-generate-upload-keystore.bat).** That's it.

The script:
- Finds a JDK on your machine (Android Studio's bundled JBR works automatically; otherwise honours `JAVA_HOME` or anything `keytool` on PATH).
- Prompts for a password — input is hidden (`Read-Host -AsSecureString`), then prompts again to confirm.
- Generates a 2048-bit RSA key valid for 30 000 days, with a clean DN (`CN=Erwin Mayer, O=Erwin Mayer, L=Menoncourt, C=FR` — edit the script if you want a different identity).
- Writes the keystore to `<repo>\upload.keystore` (gitignored) and the password / alias to `<repo>\android\keystore.properties` (also gitignored). Both files are picked up automatically by the next-step build.
- Refuses to overwrite an existing keystore so a fumbled re-run can't lock you out of Play.

> **Save the password to your password manager *immediately* after the script finishes.** If you lose it, Google's only recourse is the [Play upload key reset](https://support.google.com/googleplay/android-developer/answer/9842756) flow, which takes days.

To see the SHA-1 / SHA-256 fingerprints (Play Console asks for the SHA-256 during App Signing setup), double-click [`2-show-fingerprints.bat`](2-show-fingerprints.bat). It prints both the upload-key and the sideload-key fingerprints.

The Gradle build is wired to fall back to the sideload key if `keystore.properties` is missing, so a fresh repo clone (and the GitHub-Actions sideload pipeline) keeps working without this file.

---

## 3. Build the release AAB (~2 min)

**Double-click [`3-build-play-aab.bat`](3-build-play-aab.bat).**

The script runs `npm run cap:sync` and `gradlew bundleRelease` for you, signs with the upload key (from step 2), and prints the output path:

```
android/app/build/outputs/bundle/release/app-release.aab
```

Prerequisites the script verifies: upload keystore exists, JDK is reachable, Android SDK is reachable (set `ANDROID_HOME` if it can't find the standard `%LOCALAPPDATA%\Android\Sdk` location). It also runs `npm ci` automatically on first invocation if `node_modules/` is missing.

**Each new release**: bump `versionCode` (must increase by 1+) and `versionName` in [`android/app/build.gradle`](../../android/app/build.gradle), then re-run the build script. Step 8 below has the full per-release checklist.

---

## 4. Once the Play Console account is verified — set up the app shell

1. Open <https://play.google.com/console>, click **Create app**.
2. Fill the dialog:
   - **App name**: `Chained Timers`
   - **Default language**: English (United States)
   - **App or game**: App
   - **Free or paid**: Free
   - Tick the two declarations (developer programme policy + US export laws).
3. Click **Create app**. You're now on the app's dashboard.

### 4.1 Set up your app section (left sidebar)

Walk top-to-bottom through every row. Each one says "Start" — click and answer. The answers below are what to enter. **Bold** = field name in the Console, after `→` = your answer.

#### 4.1 App access
- → **All functionality is available without special access** (Chained Timers needs no login)
- Save.

#### 4.2 Ads
- → **No, my app does not contain ads**
- Save.

#### 4.3 Content rating
- Open [`content-rating.md`](content-rating.md). It contains your answers in order.
- Click **Start questionnaire**. Email = your developer account email. Category = **Reference, News, or Educational** (closest match — there's no "Tools/Productivity" option).
- Answer every section using [`content-rating.md`](content-rating.md). All answers will be **No**.
- Submit. Rating result: **Everyone (IARC), 3+ (PEGI), 4+ (App Store equivalent)**.

#### 4.4 Target audience and content
- → **Target age group**: 13 and older (the lowest age that doesn't trigger Designed for Families requirements; the app is fine for younger users but the form has heavier paperwork below 13)
- → **Appeals to children**: No
- Save.

#### 4.5 Data safety
- Open [`data-safety.md`](data-safety.md).
- Walk through the form using those exact answers. Result: **No data collected, no data shared**.

#### 4.6 News app
- → No.

#### 4.7 COVID-19 contact tracing
- → No.

#### 4.8 Government apps
- → No.

#### 4.9 Financial features
- → None of these.

#### 4.10 Health
- → None of these.

---

## 5. Main store listing

Left sidebar → **Grow → Store presence → Main store listing**.

### 5.1 Default language
- Already set to English (US).

### 5.2 App name & short description
- **App name**: `Chained Timers` (from [`store-listing.md`](store-listing.md) §Title)
- **Short description (80 chars)**: paste from [`store-listing.md`](store-listing.md) §"Short description"

### 5.3 Full description (4000 chars)
- Paste from [`store-listing.md`](store-listing.md) §"Full description".

### 5.4 Graphics

Upload these in the order listed:

| Field | File to upload | Dimensions |
| --- | --- | --- |
| App icon | [`icon-512.png`](icon-512.png) | 512×512 |
| Feature graphic | [`feature-graphic-1024x500.png`](feature-graphic-1024x500.png) | 1024×500 |
| Phone screenshots (need ≥2) | [`screenshots/01-library.png`](screenshots/), [`02-editor.png`](screenshots/), [`03-templates.png`](screenshots/), [`04-run.png`](screenshots/), [`05-settings.png`](screenshots/) | 1080×1920 each |

7-inch tablet screenshots: optional, leave empty.
10-inch tablet screenshots: optional, leave empty.

### 5.5 Promo video
- Optional. Leave empty for now.

### 5.6 App category and tags
- **App category**: Health & Fitness
- **Tags**: Workout, Fitness, Habit, Productivity (pick up to 5; these are guided suggestions)

### 5.7 Store listing contact details
- **Email**: your developer account email
- **Phone**: leave blank (optional)
- **Website**: <https://mayerwin.github.io/Chained-Timers/>

### 5.8 External marketing
- → **No, my app is not promoted outside Google Play**

Click **Save** at the bottom.

---

## 6. Pre-release (Internal testing track) — recommended before public

### 6.1 Open Internal testing
Left sidebar → **Test and release → Testing → Internal testing**.

### 6.2 Create new release
- **App bundle**: upload `android/app/build/outputs/bundle/release/app-release.aab` (built in step 3).
- The Console will show a green check if the signature is valid.
- **Release name**: `1.0.0` (auto-fills from versionName).
- **Release notes** (per language, English by default): paste from [`store-listing.md`](store-listing.md) §"What's new in v1.0.0".

### 6.3 Permissions declaration form
On first AAB upload, the Console will flag `USE_EXACT_ALARM` and ask for justification.

- Open [`permissions-declaration.md`](permissions-declaration.md).
- For each flagged permission, paste the matching justification from that file.
- Tick the checkbox confirming the use case.

### 6.4 Save & review
- Click **Save**, then **Review release**.
- Address any errors the Console highlights (it's strict about descriptions, content rating, etc. — it'll tell you exactly what's missing).
- **Start rollout to Internal testing**.

### 6.5 Add yourself as an internal tester
- **Testers** tab → **Create email list** → add your own Google account email.
- Save the **Opt-in URL** the Console gives you.
- Open that URL on your Android phone, accept the invitation, then install via the Play Store link.
- Internal testing builds appear in Play Store within minutes (no review).

Test thoroughly: install fresh, uninstall + reinstall, exact-alarm permission flow, segment notifications with screen locked.

---

## 7. Production release

### 7.1 Promote from internal testing
Left sidebar → **Test and release → Production → Create new release**.

- Click **Use existing app bundle** → pick the bundle you uploaded to Internal testing.
- Release notes: same as step 6.2.
- **Save → Review release → Start rollout to Production**.

### 7.2 Wait for review
- **First-time review**: ~7 days (Google manually reviews new apps).
- Subsequent updates: usually <2 days, often within hours.
- You'll receive an email when approved or if changes are required.

### 7.3 Once live
- Listing URL will be `https://play.google.com/store/apps/details?id=com.mayerwin.chainedtimers`.
- Update the README's "Install" section to link there once live.

---

## 8. Future updates (after the first release is live)

1. **Bump versions** in:
   - `android/app/build.gradle` — `versionCode` (must increase by ≥1) and `versionName`
   - `package.json` — `"version"`
   - (Also iOS — see [`../ios/README.md`](../ios/README.md).)
2. **Refresh publishing assets** if the UI changed:
   - `npm run smoke` regenerates the in-repo screenshots, then `npm run publishing:refresh` copies the relevant ones into `publishing/`.
3. **Build the new AAB**: double-click [`3-build-play-aab.bat`](3-build-play-aab.bat).
4. **Tag the GitHub release** (this triggers the GitHub-Actions sideload-APK build automatically):
   ```
   git tag vX.Y.Z && git push --tags
   ```
5. **Upload to Play Console**: *Test and release → Production → Create new release → Upload `.aab`*. Refresh screenshots in *Main store listing → Graphics* if they changed. Paste release notes from the new `What's new in vX.Y.Z` block in [`store-listing.md`](store-listing.md). *Save → Review release → Start rollout to Production*.

Updates with no new permissions usually clear Play review in <24 h.
