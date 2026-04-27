# App Store Connect — App Privacy questionnaire answers

Walk through the App Privacy section in App Store Connect. **All "data collected" answers are NO** — Chained Timers genuinely collects nothing.

---

## Step 1: Data Collection

> Do you or your third-party partners collect data from this app?

→ **No, we do not collect data from this app.**

The questionnaire short-circuits to the next section. **Skip step 2 entirely.**

---

## Step 2: Data Types (only if you answered YES above — we did not, so skip)

For reference, here's what we'd answer if Apple's policy ever changes and we must enumerate. **All categories: not collected.**

- Contact Info (Name, Email, Phone, Address, Other) → not collected
- Health & Fitness (Health, Fitness) → **not collected** (the chains *describe* exercises but the app stores no health metrics)
- Financial Info → not collected
- Location (Precise, Coarse) → not collected
- Sensitive Info → not collected
- Contacts → not collected
- User Content (Emails, Messages, Photos, Videos, Audio, Gameplay Content, Customer Support, Other) → not collected
  - The chains the user creates ARE stored, but locally on the device only — no third party receives them.
- Browsing History → not collected
- Search History → not collected
- Identifiers (User ID, Device ID) → not collected
- Purchases → not collected
- Usage Data → not collected
- Diagnostics (Crash Data, Performance Data, Other Diagnostic Data) → not collected
- Other Data → not collected

---

## Step 3: Tracking

> Does your app use data to track users?

→ **No**

This sets the App Store badge to **"Data not used to track you"** — a strong selling point in App Store search.

---

## Result on the listing

After publishing this section, the App Store listing will display the **App Privacy** card as:

```
Data Not Collected

The developer does not collect any data from this app.
```

This is the cleanest possible privacy badge Apple shows, and it's accurate.

---

## Annual confirmation

Apple asks you to re-confirm App Privacy answers periodically. If they prompt:
- **No data collection has changed** → click confirm.
- If you ever add data collection in a future version, update this file FIRST (before changing the form), so future agents have the correct source-of-truth.
