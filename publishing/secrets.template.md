# Publishing secrets — template (copy → fill → keep local)

This file is **committed**. The filled-in version, `secrets.local.md`, is **gitignored** and should NEVER be added to git.

To use:

```bash
cp publishing/secrets.template.md publishing/secrets.local.md
# then edit publishing/secrets.local.md with your real values
```

If you store your secrets elsewhere (1Password, Bitwarden, Keychain, etc.) — that's fine, you don't need `secrets.local.md` at all. This file just enumerates what to keep track of.

---

## Google Play Store

### Upload keystore (Android)

```
File:        android/upload.keystore                (gitignored)
Properties:  android/keystore.properties            (gitignored)
Alias:       chainedtimers-upload
Generated:   <date>
Validity:    27 years (10000 days from generation)
```

```yaml
keystore_password: "<PASTE HERE>"
key_password:      "<PASTE HERE>"
sha256_fingerprint: "<run: keytool -list -v -keystore android/upload.keystore | grep SHA256>"
```

> ⚠ **Lose this and you lose Play Store update rights.** Back up `android/upload.keystore` to two physically separate places (cloud + offline drive). If lost, you would have to re-publish under a new package name and orphan your existing user base.

### Play Console developer account

```yaml
google_account_email: "<your developer email>"
developer_account_id: "<8-digit ID, shown in Play Console URL after signup>"
play_console_url: "https://play.google.com/console/developers/<id>"
```

### Optional — Play Developer API service account (for automated upload)

If you ever automate AAB uploads from CI:

```yaml
service_account_email: "play-deploy@chained-timers.iam.gserviceaccount.com"
service_account_json:  "<paste contents of the downloaded JSON, or path to file>"
gh_actions_secret_name: "PLAY_SERVICE_ACCOUNT_JSON"
```

---

## Apple App Store

### Apple Developer Program

```yaml
apple_id_email:        "<your Apple ID>"
apple_team_id:         "<10-char alphanumeric, shown at developer.apple.com/account>"
apple_team_name:       "<your name or org>"
program_renewal_date:  "<MM/YYYY — set a reminder 30 days before>"
```

### App-specific password (for altool / xcrun upload)

Generate at <https://account.apple.com/account/manage> → App-Specific Passwords.
Use only when uploading builds outside of Xcode (e.g. CI).

```yaml
app_specific_password: "xxxx-xxxx-xxxx-xxxx"
gh_actions_secret_name: "APPLE_APP_SPECIFIC_PASSWORD"
```

### Distribution certificate

Xcode-managed by default. If you ever export it:

```
File:        Apple_Distribution.p12   (do NOT commit, keep in password manager)
Password:    <password chosen at export>
Bundle IDs:  com.github.chainedtimers
```

### App Store Connect API key (for fastlane / xcodebuild --apiKey)

If you set up automated TestFlight/App Store submissions:

```yaml
api_key_id:        "ABCDEFGHIJ"
api_key_issuer_id: "abcdef-1234-5678-9012-abcdef123456"
api_key_p8_file:   "AuthKey_ABCDEFGHIJ.p8"   # downloaded once, gitignored
gh_actions_secret_name: "APP_STORE_CONNECT_API_KEY"
```

---

## Sideload (already public, no secrets)

The repo's `android/sideload.keystore` is intentionally public. Password is `sideload`. Anyone can build a fork signed with the same key — that's by design for sideload distribution.

---

## Where to store all this

- Personal use: a password manager (1Password, Bitwarden, Apple Keychain, etc.) with a vault entry per app.
- Org use: a shared password manager vault, or a sealed env file in a CI secrets store (GitHub Actions Secrets, Vault, etc.).

Whatever you do — **never commit `secrets.local.md`, `android/upload.keystore`, `*.p12`, or `*.p8` files to git.** The `.gitignore` is set up to block these patterns; running `git status` should never show any of them.
