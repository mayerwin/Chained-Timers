# Play Console — Data Safety form answers

This is a step-by-step walk through every question in the Play Console's Data Safety form. **All "data collected/shared" answers are NO** — Chained Timers genuinely collects nothing.

---

## Section 1: Data collection and security

**Does your app collect or share any of the required user data types?**
→ **No**

> If you answer No, the form short-circuits and you skip the entire data-types matrix below.

**Is all of the user data collected by your app encrypted in transit?**
→ Not applicable (no data is collected). The Console may still ask — answer **Yes** if forced, since the answer is vacuously true.

**Do you provide a way for users to request that their data be deleted?**
→ Not applicable. If forced to answer: **Yes, the user can delete all in-app data via Export library → delete the file, plus Settings → Apps → Chained Timers → Storage → Clear data.**

---

## Section 2: Data types

Skipped because Section 1's first answer is **No**.

For reference, if Google's policy ever changes and you must enumerate, here's the complete list of data types Chained Timers does NOT collect or transmit:

| Category | Items | Collected? | Shared? |
| --- | --- | --- | --- |
| **Personal info** | Name, email, address, phone, race, ethnicity, political views, sexual orientation, religion, identifiers, other | ❌ | ❌ |
| **Financial info** | All items | ❌ | ❌ |
| **Health & fitness** | Health info, fitness info | ❌ | ❌ |
| **Messages** | All items | ❌ | ❌ |
| **Photos & videos** | All items | ❌ | ❌ |
| **Audio files** | All items | ❌ | ❌ |
| **Files & docs** | All items | ❌ | ❌ |
| **Calendar** | All items | ❌ | ❌ |
| **Contacts** | All items | ❌ | ❌ |
| **App activity** | App interactions, in-app search history, installed apps, other | ❌ | ❌ |
| **Web browsing** | History | ❌ | ❌ |
| **App info & performance** | Crash logs, diagnostics, other | ❌ | ❌ |
| **Device or other IDs** | Device IDs | ❌ | ❌ |
| **Location** | Approximate, precise | ❌ | ❌ |

The chains the user creates are stored in browser `localStorage` (PWA) or via the `@capacitor/preferences` plugin (native). Both are local-only — no SDK has access to them.

---

## Section 3: Security practices

**Is all of the user data collected by your app encrypted in transit?**
→ **Yes** (vacuously true, no data is transmitted).

**Do you provide a way for users to request that their data be deleted?**
→ **Yes** (Settings → Apps → Chained Timers → Storage → Clear data; or uninstall the app).

---

After submitting, the Play Console will display a green **Data safety section: complete** badge. The store listing will show a "No data collected" pill — this is a strong selling point in Play Search.
