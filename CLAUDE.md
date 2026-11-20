# Peek Budget (repo: substracker)

PWA on GitHub Pages (main only) plus a Capacitor Android wrapper (com.tcjabc.peekbudget). Data is local-first; sync is an end-to-end encrypted Cloudflare relay with 12 recovery words. Every feature is free. Do not rename the repo (stored PWA data is tied to the Pages URL).

## Hard rules
- Never change the group-name hash, the sync format or the export format without a written migration plan.
- Never paste, log or screenshot the household key or the 12 words.
- Never push or merge unless the prompt says so with exact steps.
- Never build a release APK for the test phone; debug only. Export a backup before any uninstall.
- Never paywall: data, export/import, Import with AI, biometric lock, sync, charts, wallet, sort, calendar, due-soon chip, languages.
- Cross-platform parity: no feature on one OS only.
- Any total shown anywhere is on the cash basis (js/insights-calc.js) or clearly labelled; never an unlabelled average.

## Every change
- User-facing strings go through t(), keys in BOTH js/locales/en.js and js/locales/zh-TW.js (parity test). Mark new zh-TW strings for my review in the handoff; I am not a native writer. Flag legal-check strings.
- Honour "Reduce motion and effects" (plain fallback; transition-property: none where a size step must apply at once).
- New overlays go on the overlay stack (js/overlays.js) so Android Back works.
- Check layouts at 320, 360 and 393 px, light and dark.
- Version fields move together: APP_VERSION in js/app.js, package.json, BOTH package-lock.json entries, Android versionName/versionCode, sw.js VERSION. Check the highest version on every origin branch first; versionCode must exceed what is installed on the phone.
- One branch per feature. Never run two sessions in the repo folder at once.

## Testing (save time: do not over-run)
- Run suites ONE AT A TIME, never in parallel, and never alongside another heavy job (another session's tests or an Android build). 2-minute limit each. app.html is near the limit: new browser tests go on their own page.
- Local test servers use port 8090, not 8080 or 8765. Check the port is free before starting.
- Tier the sweep by what changed:
  1. New or touched areas: full matrix (320/360/393 x English, pseudo ?lang=xx, zh-TW x Reduce motion on/off).
  2. Suites for untouched areas: one smoke run at 393 normal motion.
  3. Full matrix on every suite only for big releases or when the prompt asks.
- During development run only the single test file you are working on; do the broader sweep once, at the end, on the final commit.
- On a failure, rerun that one run alone before investigating; one-off timeouts have passed on rerun. Before blaming a change, compare against untouched main on the same machine (a few browser tests fail identically on main on the desktop runner: nav pill stretch in non-reduced runs, nav tab-bar inset at 320x640, the pseudo-locale Year chart at 320x640).
- Node tests also run under America/New_York. Set the zone from PowerShell ($env:TZ = 'America/New_York') and print Intl.DateTimeFormat().resolvedOptions().timeZone first; Git Bash TZ= did not reach Node.
- A lone --reduce flag is lost through a PowerShell one-element array: confirm the flag reached each reduced run.
- Use headless Chrome for animation tests (a hidden browser pane stops the animation timeline: many app.html checks fail with a hidden pane). Use a no-cache server for the browser pane.
- Do not take screenshots or dump pages repeatedly to check work you can assert in a test; prefer a measurement in code.

## Editing and files
- Edit with the Edit tool or script files. Never sed -i. Heredocs eat backslashes (even quoted): write scripts to files.
- Keep each file's own line endings (most js/ and tests are CRLF, a few LF; check raw bytes with od) and its final newline.
- Write invisible Unicode (no-break space etc.) as \u escapes in source and commit messages, and re-read each commit message afterwards.
- Read only the files and line ranges you need; search before reading whole files.

## Android build and phone (desktop PC only)
- JDK 21 at C:\Users\tcjab\.jdks\jbr-21.0.11, set as JAVA_HOME per command only (Android Studio's JDK 25 breaks Gradle). Do not upgrade AGP 8.13.0 / Gradle 8.14.3.
- Build: npm run sync:web, restore line-ending-only changes in android/app/capacitor.build.gradle and android/capacitor.settings.gradle, gradlew.bat assembleDebug.
- adb: C:\Users\tcjab\AppData\Local\Android\Sdk\platform-tools\adb.exe (not on PATH). Mi 9T serial 54b7e814: adb -s 54b7e814 install -r <apk>; an older versionCode needs -r -d. Always pass -s. The emulator (PeekBudget_API33, emulator-5554) is for fictional data only and is never mixed with the phone.
- The phone must be unlocked for launch checks; otherwise say so and leave the phone check to me.

## Handoff summary (end every task with this, paste-ready, concise)
Branch, base commit, every commit hash and the tip; what changed per item; files; all version fields; locale keys added/changed/removed; English snapshot screens changed; test counts per suite and viewport (both motion modes; Node in New York time confirmed); failures vs main on this machine; deviations; new known issues; zh-TW strings to review; phone-check list.
