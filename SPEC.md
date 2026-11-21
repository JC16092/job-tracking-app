# Tastings — build spec (v1)

Working name: **Tastings**. It is not final, so keep it in as few places as possible: the `<title>` and headings in `index.html`, the manifest, the cache name in `sw.js`, and `site` in `firebase.json`.

## 0. Changes made after the build started — read first

- **How v1 was actually built (14 Nov 2026).** Where the code and this spec differ, the code is right:
  - Sync listens to the whole `tastings_days` collection, the way Hours listens to its entries. There is no 120-day window: `remote.fetchDays` and `store.ensureRange` exist but do nothing. Worth revisiting only after a few years of data.
  - Run every check with `node --test` from the project folder (80 checks: `tests/` and `tools/sw.test.mjs`). Node 24 does not accept a folder name after `--test`.
  - `model.js` also exports `peekUndo`, `peekRedo`, `lateTapInfo`, `isRunning`, `dateText` and `time12`; `pay.js` also exports `toMin`, `fromMin` and `daysBetween`.
  - Tested by hand in demo mode in a phone-sized window, including a launch with the server switched off. Not yet tested: real sign-in and sync against Firebase, and anything on the real iPhone (Home Screen install, keeping the screen on, the Maps links opening the Google Maps app).

- **Toll-free routes only (13 Nov 2026).** The user is not reimbursed for tolls, so every trip is driven and measured on toll-free roads. What changed: `config.avoidTolls` (default `true`) is new; `mapsUrl(from, to, avoidTolls)` adds `&avoid=tolls` when it is on (a documented Maps URLs parameter; checked on the Google Maps website, where it switches the route options to "Avoid tolls"); the Trips wording and a Settings switch are in section 7; section 10 has the check. If `public/model.js` was written before this change, the interface engineer adds it there — the default in `defaultConfig` / `withConfigDefaults`, the third `mapsUrl` argument, and tests in `tests/model.test.mjs`. This is an allowed foundation fix.

- **A minus button in each count box (14 Nov 2026, v2, asked for by the user).** The single Undo bar is gone. On the Counter each count is now one box with two parts: a narrow white **−** strip on the left that takes one off that count, and the rest of the box, in colour, that adds one. Details:
  - Add still counts on `pointerdown`. The minus acts on `click` (finger down and up on the minus itself), so a finger that lands on "add" and slides never takes one off.
  - The minus undoes the newest counted tap of that kind (`model.undoKind`), wherever it sits in the log. If the number only exists as a hand correction, it lowers the correction. At zero the minus is greyed out.
  - The line above the numbers is always there and always the same height. It names the last count; for 15 seconds after a minus it reads "Took one off … — tap here to put it back" and restores that tap (`model.redoAt`). Counts taken off are remembered newest-first for that time only.
  - Opening the Finish sheet drops any pending "put it back", because the numbers can be typed over there. A minus never acts on a count that shows zero, and a touch on a greyed-out minus adds nothing.
  - Where section 7 below still describes the Undo bar, "Put back" after an undo, and the hold after three undos, this note replaces it.

- **A big Finish button (14 Nov 2026, v3, asked for by the user).** The user could not find how to finish a tasting. Finish is no longer a small button in the top corner: under the store name there is now a full-width pink button, "Finish tasting" (pink is the family's "stop the clock" colour, as in Hours). The store name and running time moved to the left of the top row and Lock to the right. In landscape the button sits beside the top row to save height. It still only opens the Finish sheet, so a mistaken tap loses nothing.
  - To make room, and so the count boxes never change size, the "Started earlier? / Wrong store?" bar that used to sit above the numbers before the first count is gone. Before the first count the fixed line above the numbers reads "Paid from 10:00 am. Started earlier, or wrong store? Tap here" and opens a sheet with the same choices (15, 30, 45, 60 minutes earlier; cancel this tasting). After the first count the line shows the last count, as before. On a 375 × 667 screen each count box is about 160 px tall at all times.

- **The day is planned up front (14 Nov 2026, v4, asked for by the user).** The user's days are always two tastings at two stores that change every day, with booked shift times they want to type in themselves. Home is one fixed address.
  - Today → **Add a tasting**: store name, store address, shift start and end. The times are typed; they come pre-filled with what was typed last time for that position in the day (`config.usualShifts`). The six most recently used stores are offered as shortcuts. Buttons: "Add and start counting" (today, nothing running) and "Add for later".
  - A tasting added this way is **planned**: `startedAt` and `endedAt` both null, `startManual` and `endManual` true. It is paid from its typed times and is on the route at once, so all three trips (home → store 1 → store 2 → home) appear as soon as both are added, before leaving home.
  - Its card on Today has a **Start counting** button (today only, when nothing is running). Starting keeps the typed times (`model.startVisit`); tap times are only evidence.
  - Before the first count, the fixed line reads "Shift 10:00 am – 2:00 pm. Wrong store or times? Tap here": back to counting, change the shift times (opens the tasting sheet), or "Not this store — stop counting", which puts the tasting back to planned with nothing counted (`model.unstartVisit`).
  - Gone: the "tap a store to start" list, "Add by hand" and the "started earlier" choices. Typed shift times replace all three. To record a tasting that was not counted on the phone, add it and type the two counts on its sheet.
  - Today prompts for the home address while it is empty. The home address is never built into the code, because the published files are public; it is typed once in Settings and lives in the user's private config.
  - Settings lists only the 8 most recently used stores and no longer has its own "add a store" field: stores are added with a tasting. A typed store name that is already saved reuses that store, unless a different address is typed.
  - `config.usualShifts` always holds the last-edited day's shift times in clock order, so the 1st and 2nd tasting are pre-filled correctly whatever order they were typed in.
  - Sync rule for planned tastings (`mergeDay` in `store.js`, which now receives whether the local day has unsynced changes): local taps are carried onto a newer remote copy only when it is the same run (same `startedAt`); a run started here and not yet synced is kept whole when the remote copy still has the tasting planned or lacks it; a tasting stopped or removed on another device is not brought back by a copy with nothing unsynced.
  - `model.unstartVisit` also clears the hand corrections (`adjS`, `adjN`), which were made against taps that no longer exist.
  - "Change the shift times" from the Counter opens the tasting sheet with a single button, "Save and go back to counting", so correcting a time cannot finish the tasting. The "No counts yet" prompt starts with "Back to counting".
  - Known limit to revisit: with two new stores a day, `places` and `kmMemory` grow the config by roughly 200 KB a year, and the days take roughly 1.2 MB a year of localStorage (about 5 MB available). Old tap logs and old remembered km will need trimming within about two years.

- **Version 5: the complete app (14 Nov 2026).** The user gave standing authority to improve and publish this app without asking each time ("update this app to the full fledge level fully user friendly custom app for me"). Three independent reviews (a week in the user's shoes, plain words, what a finished tool would have) decided what went in. Where sections 5 to 7 below differ from this note, this note and the code are right.
  - **Today is the day, top to bottom.** One panel shows the route as it is driven: Home, the trip, the tasting, the next trip, the next tasting, the trip home. Each trip row has its name on its own line, then its note, km box and Maps button. Above it, on today only, one **next step** card with one big button: "Start counting" (with Directions) for the next tasting that has not started, "Back to counting" while one runs, "Go to the km" when every tasting is finished and km is missing, "See the day report" when the day is complete. Tasting cards no longer carry their own Start button (the card opens the sheet, which has one).
  - **First-time guide** on Today until done or hidden: home address, check pay rates and pay week (`config.setup.ratesChecked`), Avoid tolls in Google Maps (`config.setup.tollsDone`), first tasting. `config.setup.hidden` hides it; Settings can show it again.
  - **One km figure for the whole day** (beside the per-trip boxes, never instead of them). "Whole day in one go" opens ONE Google Maps route, home → every store → home (`model.mapsDayUrl`, `waypoints` joined by `|`, `avoid=tolls`; checked on the Google Maps website with three stops), and takes its total. Day fields: `kmDay` (tenths), `kmDayOn`, `kmDayTime`, `kmDayFor` (the route it was measured on, `model.routeKey`). While `kmDay` is a number it is the day's km and the trips' own figures are ignored (`pay.dayTotals` returns `kmWhole`). It is removed when the route changes (`rebuildLegs`), when a trip is marked not driven (`setLegSkip`), when an address on the route changes, or when the box is emptied.
  - **Counter.** "My day" (beside Finish) leaves the Counter without finishing: the tasting keeps running and Today shows "Back to counting". Under the store name: "1 h 20 m left · ends 2:00 pm", then "Shift ended at 2:00 pm" once the typed end has passed; the Finish button then gets a yellow outline and blinks for half a minute. Labels are the report's words: "Sample given", "Rejected or ignored". Three-digit counts shrink to stay inside their box; phones narrower than 350 px get tighter boxes.
  - **Finishing is one short screen.** Finish opens the three numbers, the shift and its pay, the parking box, one pink "Finish tasting" and a green "Back to counting". Everything else (store, brand, numbers, times, break, note, delete) is under "Change the numbers or times, or add a note", which opens by itself when something needs a decision (late taps, wrong times, the after-6-pm question, no finish time). After finishing, a sheet shows the report with **Share report** (the phone's share sheet) and Copy, then the next store with Directions, or the whole day report.
  - **Opening the app late.** A tasting still running from an earlier day opens its finish screen. One opened more than 30 minutes after its typed end opens the Counter with the finish screen on top ("The shift ended at … Finish the tasting here, or go back to counting").
  - **Day report** (`report.dayReportText`): both tastings with brand, time and the three numbers, the travel km (per trip, or the whole-day figure) and parking. No pay amounts: it goes to the agency. Shown before it is sent, with Share and Copy.
  - **Brand** on a tasting (`visit.brand`, optional): typed on Add a tasting or on the sheet; shown on cards and in reports. **`visit.zeroOk`**: "Yes, nobody to count" on a past tasting with no counts stops it being listed as needing counts.
  - **A store can be fixed from its tasting** (row at the top of the sheet, and "Change the store name or address" from the Counter). Saving a store updates its name on today's and later tastings and on the day being viewed, and rebuilds their trips. If the address changed, km typed for trips to or from it on those days is emptied to be measured again. Earlier days are left as they were.
  - **Add a tasting**: stores used before sit above the name and narrow as the name is typed; after the day's first tasting the app offers "Add the second tasting".
  - **Pay**: "Days to fix" (last 60 days: km missing, wrong times, a tasting never finished, counts not entered — `report.todoList`; Today links to it); the payslip box (`config.paid["<period start>:<7|14>"]` in cents) with "matches / less / more"; the people numbers for the period; "Save as spreadsheet" (`report.periodCsv`, UTF-8 with a leading mark for Excel, through the share sheet or a download); a month calendar (`report.monthGrid`; days needing something are orange); the tax year so far (1 July to 30 June). The week/fortnight choice left the Pay tab (a stray tap regrouped every period); it is in Settings and in the "Check your pay" sheet.
  - **Rates that change on a date.** "My rates changed" adds a new set from a date (`config.rateSets`); earlier days keep the old rates. The rate boxes show and change the set in force today (`currentRateIndex`). Sets can be removed while more than one exists.
  - **My data** in Settings: how full the phone's app storage is; "Save a backup file" (`report.backupText`, JSON, share sheet or download; it contains the home address); "Bring back days from a backup file", which only ADDS days this phone does not have (`model.cleanBackupDay` refuses anything not shaped like a day; a tasting saved while running comes back finished), adds stores this phone does not know, and restores settings only onto a phone that has none.
  - **Help**: the "?" button in the top bar and a row in Settings open twelve short answers. A bar appears when changes have been waiting to be backed up for more than a day.
  - **Words.** One name for each thing everywhere: "People talked to", "Samples given" / "Sample given", "Rejected or ignored", "Shift starts / Shift ends", "Back to counting", "Total pay, before tax", "backed up" for sync. Errors say what to do next.
  - **Code.** New pure module `public/report.js` (reports, CSV, month grid, to-fix list, financial year, backup text) with `tests/report.test.mjs`; it is in the service worker's shell list. `node --test` runs 127 checks. `app.js` gained a third delegated event, `input` → `I[data-inp]`, for fields that act as they are typed in.
  - **Fixed after the independent review of version 5** (eight agents: four reviewers, each finding then checked by a sceptic; 19 findings confirmed, 4 refuted). Several of these were in the app since version 1:
    - *The day changes while the app sleeps.* An iPhone keeps a Home Screen app in memory overnight, so "Today" could still be yesterday. `rollDay()` (on return to the app and every 30 seconds) moves screens that were showing today to the new today; a day picked on purpose, an open sheet and a running Counter are left alone.
    - *Typing from one box straight into the next* (km boxes, rate boxes) closed the keyboard on an iPhone: the first box saved itself and the view was redrawn before the next box had focus. A redraw asked for from inside a field's `change` now waits one tick (`inChange` in `render()`), by which time the typing guard holds it.
    - *A number still being typed is saved when the app is left* (to Google Maps, say) and when a sheet is closed by the dark area or the X: the focused field is blurred first, which fires its `change`.
    - *Restore waits for the account.* `store.status().ready` is true once the account has answered for both settings and days since sign-in (`remote.subscribe` now passes `{ fromCache }`; an answer from the SDK's own memory is applied but does not count). Until then "Bring back days" refuses, so a file can never replace newer work that has simply not arrived yet.
    - *Rates.* The earliest set of rates cannot be removed (earlier days would be re-priced). A rate of 0 is refused; 0 in "Weekday after 6 pm" means empty. Answering "yes" to the after-6-pm question also fills sets that start later.
    - *Counts typed by hand survive "Not this store — stop counting"* (`A.cancelVisit` keeps `adjS` / `adjN` when no tap was made). A tasting whose counts were typed by hand is treated as done when choosing the next step (`isWaiting`).
    - `parseMoney("1,234")` is 1234 dollars (a thousands comma), `"6,50"` still six dollars fifty. A first address for a store marks its remembered km for checking, like a changed one.
    - A second check of these fixes (three checkers, each finding re-checked by a sceptic) found six more points, all fixed: `rollDay()` never runs under a field being typed in, and is called when the Counter is left (Finish, "My day") so a Counter that was open across midnight cannot later pull the screen off a day chosen on purpose; the "Which km is right?" question carries the day it was asked on, and a tap that made the question appear does nothing else; an unreadable "Weekday after 6 pm" rate is refused instead of being read as empty; the two Firestore listeners use `includeMetadataChanges`, so "the account has answered" cannot get stuck after this phone's own write or an offline start (`docChanges()` still leaves metadata-only changes out, so documents are passed on exactly as before); offline with nothing waiting says "Offline — saved on this phone" instead of "Connecting…".
    - The Counter's status line is always one line (the count boxes cannot move when it changes). "Hold to delete" on the "No counts yet" sheet. "Back to counting" always opens the Counter; a tasting left from an earlier day gets "Not now" instead, and "Go to today" after it is finished. Hints name the button that is really there ("Add address" when a store has none). The calendar marks every day that "Days to fix" lists. "Check for update" says when the new version is still downloading.
  - **Left for later.** Tidying old tap logs when storage fills (the meter is there; nothing trims yet). A "receipt kept" tick on parking. Copying addresses onto each trip. Not tested on a real iPhone: the whole-day link opening in the Google Maps app with all its stops and without tolls, the share sheet for text and files, and (still) real sign-in and sync.

- **Version 6: flavours, Sold, total interactions, the payslip (21 Nov 2026).** Asked for by the user after a week on version 5. Their answers to three questions fixed the rules: **every sample is one interaction** (a customer who tries two flavours is two interactions); **rejected is one number** for the whole tasting; **Sold is counted for each flavour** (one tap = one bottle or pack). Where sections 5 to 7 below differ from this note, this note and the code are right.
  - **Data (all added, nothing renamed).** A tasting gains `flavours` (names in order, at most `model.MAX_FLAVOURS` = 6; `[]` = one plain product), `tapF` (one mark per tap beside `tapT` / `tapK`: `"0"`…`"9"` = the flavour's place in the list, `"-"` = none), `adjB` (hand correction of Sold with no flavour), `adjF[]` and `adjBF[]` (hand corrections of samples and Sold for each flavour) and `comments` (what customers said). `tapK` gains `"B"` = one sold (lower case = taken off, like the others) and `"x"` = a taken-off tap of a flavour that was removed since (never counted, never put back). A `tapF` shorter than `tapK` reads as "no flavour" for the missing end, so tastings from before version 6 need no change and still add up. Config gains `brands` (`[{ name, flavours, lastUsed }]`, newest first, at most 30) and `payPeriod.confirmed`.
  - **Counting.** `model.counts(visit)` → `sampled` (all samples), `declined`, `talked` (= sampled + declined: **total interactions**), `sold`, `plain` (the part with no flavour) and `flav[]` (one entry per flavour: `name, sampled, sold, tapS, tapB`). Sold never adds to interactions. `countOf / setCount / bumpCount(visit, kind, flavour)` read and change one count; a typed-over number is a correction beside the log, never a rewritten log. "No flavour" is `-1`, `null` or nothing; a flavour that is not in the list is no count at all. `undoKind(visit, kind, flavour)` and `findTap` work on exactly one count. After taps leave the log, corrections are cut back so no count is below zero underneath (`settleAdj`): a tap always raises its count by one.
  - **Flavours** are added at the end, renamed, or removed while nothing is counted for them (`addFlavour`, `renameFlavour`, `removeFlavour`; later flavours and their taps move up one place). A name cannot hold a comma, semicolon or line break (they separate names when typed as a list). Marks that point at no flavour are written down as "no flavour" before a flavour is added (`settleMarks`). A brand remembers its flavours (`rememberBrand`, `brandFlavours`), so they are typed once.
  - **The Counter's rows are drawn by the app** (`buildPad`, once per tasting and again only when its flavours change): "Rejected or ignored" on top, then one row per flavour — or one row for a product with no flavours — holding **Sold on the left (blue) and the samples on the right (green), under the thumb**. Every count has its own "−". Sizes follow the number of rows (`#cPad[data-rows]`); on phones under 700 px high the band becomes one line and, from five flavours up, is hidden. The band shows Interactions, Samples, Sold. The old `.c-box{min-height:120px}` no longer applies inside `#cPad`.
  - **Words.** "People talked to" is now **"Total interactions"** everywhere (the user's word for the number they must write). "Trips" on money lines is "Travel". "Total pay, before tax" is **"Total payout, before tax"**.
  - **Reports** (`model.countLines`, used by `reportText` and `report.dayReportText`): Total interactions, Samples given (and each flavour), Rejected or ignored, Sold (and each flavour), Customer comments. A tasting from before version 6 never prints "Sold: 0" (`model.tracksSold`). A day with more than one tasting ends with a "Total for the day" block. The spreadsheet has five blocks (a new "Flavours" block; Sold and Customer comments columns; "Total hours" and "Pay for hours" rows).
  - **The tasting sheet** has one block per flavour (name, Samples given, Sold), a box to add a flavour, "Customer comments — they go into your report" beside the private note, and two helper lines that stay in the app: about one sold for every N samples, and the busiest hour (`model.busiestHour`). No targets, records or "samples per hour" are ever shown (responsible service: the app must not encourage pouring).
  - **Add a tasting** takes the brand (brands used before are offered) and the flavours typed with commas ("Lime, Mango"); a remembered brand fills them in. One flavour alone is stored as no flavours.
  - **The Pay tab opens on the Payslip** (`ui.payView`: `"slip"` or `"more"`, a switch at the top). The payslip shows only the payout: hours by pay type, **Total hours**, **Pay for hours**, Travel, Parking, **Total payout, before tax**, the reasons it is "not final yet" (each saying whether it is in the total or not: a tasting still running, wrong times, trips with no km, shifts still to work — which are already in the total — and a period that has not ended), the check against the real payslip, Share / Copy, then the days one by one and earlier pay periods with "Paid in full / Short by … / Not checked". Each day shows the same figure as Today; a "Rounding" row appears only when days and total differ (with today's rates at most 2 cents). "Days and year" holds days to fix, the calendar, the year and the spreadsheet. All of it is worked out fresh by `report.payslipData / payslipText / paidVerdict / paidHistory / periodChoices`; nothing new is stored except what the user types.
  - **Week or fortnight.** A new setup starts on the fortnight (`payPeriod.days: 14`); a stored 7 or 14 is never changed. Until `payPeriod.confirmed` is true the payslip shows one card: "How often are you paid?" and "Which pay fortnight are you in now?" with the two possible Monday fortnights (or the one week) as buttons, which sets the length and the start day in one tap.
  - **Checks.** `node --test` runs 288 checks. `tests/v6-model.test.mjs` and `tests/v6-payslip.test.mjs` (160 of them, with seeded random runs) were written by two independent test writers from the intended behaviour, not from the code; they found eight defects in the first draft of the counting engine, all fixed (a typed-over number could swallow the next tap; a removed flavour's taken-off tap could come back with no flavour; a flavour name with a comma; a stale flavour changing the wrong count; marks pointing at no flavour being captured by a flavour added later; a payslip amount that is not a number). A payslip also flags an earlier shift that was typed in but never counted ("It is in the total — check that you worked it").
  - **Fixed after the independent review of version 6** (four reviewers, each finding re-checked by a sceptic: 15 confirmed, 4 refuted). A flavour name typed on the tasting sheet is never lost: Return adds it, several names with commas are added as several, and a name still in the box when another button is tapped is added first (`commitNewFlavour`; the tap is then repeated by the user). A brand's remembered flavours are never replaced by "none"; typing a known brand on a tasting with no flavours and nothing counted brings its flavours. The payslip says a running tasting's shift hours are **already in the total** when its times are typed (`inTotal`), and "not in the total yet" only when it has no finish time. A tasting counted in version 6 always prints a Sold line (`startVisit` / `reopenVisit` set `adjB`), Sold typed for a flavour on an older tasting is in the report (`tracksSold` is also true when anything is sold), and setting Sold to the 0 it already is leaves an older tasting without a Sold line. Sold taps are never treated as "pocket taps" (`lateStart` looks at samples and rejections only): bottles sold are often tapped in at the end of a shift. The day block of the day report is headed "Total for the day". The pay period question is one list (two fortnights, one week), one tap. With the phone on its side the Counter's rows sit two side by side with each name beside its number.
  - **Fixed after a second independent review of version 6** (two reviewers try to break the first round's fixes, each finding re-checked by a sceptic: 6 confirmed, 0 refuted). "Remove them" for late pocket taps now removes only the late samples and rejections, never the bottles sold around them (`dropLateTaps` keeps the Sold taps). Typing a brand onto a tasting that already carries another brand's flavours no longer overwrites that brand's remembered list, and a flavour name waiting in the add box is not thrown away when a known brand fills its flavours in (`C.vsBrand`). Choosing the pay period on the first-time card lands on the period that holds today, not the one last shown (`A.periodPick` sets the date before the redraw). A payslip calls an earlier uncounted shift "in the total" only when its times are right, not when they are wrong and it is paid nothing (`report.payslipData` checks `visitProblems`). When two phones disagree, a run started here carries its own flavour list onto a still-planned remote copy, and carried tap marks that would point at the wrong flavour are left blank instead (`store.mergeDay`). A brand retyped in a different case keeps its first spelling, on the tasting and in the remembered list (`model.brandName`).
  - **Suggestions added without being asked for** (the user asked for ideas, then had no preference): remembered flavours per brand, customer comments in the report, the two helper lines. Not added: stock counts, bottles opened, a store manager's name, photos.

## 1. What it is

A personal web app for one person, an alcohol brand ambassador in Melbourne who runs tasting stalls in liquor stores. It is used on an **iPhone, installed to the Home Screen**, one-handed, at the stall, often with poor reception. For every work day it tracks:

1. **People counts per tasting**: Sampled, Rejected or ignored, and Talked to. The user confirmed that "talked to" includes people who ignored them, so Talked to = Sampled + Rejected or ignored. Two count buttons, one tap per person.
2. **Paid hours per tasting**, at the right rate for the kind of day.
3. **Km for every leg** home → store A → store B → home, paid at $1.00 per km, using the km Google Maps shows.
4. **Parking costs.**

It shows what a day and a pay period should pay, before tax, so the user can compare it with the payslip.

## 2. House pattern — this app is a sibling of Hours and Pace

Read these before writing code and match them unless this spec says otherwise:

- `hours/public/` — the closest sibling (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `firebase-config.js`), plus `hours/firebase.json` and `hours/.firebaserc`
- `pace/public/styles.css` (same design language, has a bottom tab bar) and `pace/firestore.rules`

What "same pattern" means:

- Plain static files in `public/`. No framework, no bundler, no `package.json`, no npm dependencies. ES modules loaded by the browser.
- Firebase JS SDK **10.14.1** from `https://www.gstatic.com/firebasejs/10.14.1/` — the same version Hours uses.
- The same Firebase project as Hours and Pace: **`your-project-id`**. Google sign-in by popup, one allowed account (`OWNER_EMAIL`), written the way Hours writes it.
- Firestore rules live in `~/pace/firestore.rules` and already let the owner read and write every path. This project has no rules file and never deploys rules.
- Firebase Hosting, multi-site like Hours. Site id **`tastings-jay-1609`** is a placeholder until the user confirms the name.
- Look: "Memphis" — 3px black edges, hard offset shadows, Rubik, light only, the same CSS tokens as Hours and Pace (`--edge`, `--bw`, `--sh`, `--sh-lg`, …). Lead colour **violet `#9B5DE5`** on ground **`#F6F1FF`**, so the three apps can be told apart on the Home Screen (Pace is yellow on cream, Hours is blue).
- This app only uses the Firestore collections **`tastings_days`** and **`tastings_config`**. It never reads or writes anything Hours or Pace own (`entries`, `timer`, `config`, `shifts`, `expenses`, …).

**Hard rules for anyone working on this project**

- Do not deploy. Do not run `firebase-tools`. Do not create the hosting site. Do not sign in to anything.
- Do not change anything outside `JOB TRACKING APP`. The sibling apps are read-only references.
- Do not `git init`, and do not add `package.json` or install packages.
- Only create or edit the files assigned to you (section 4).

## 3. Where this app differs from Hours, and why

Hours talks to Firestore directly and needs a connection. This app has to keep counting inside a store with no reception and must open instantly, so it is **local-first**:

- The phone's `localStorage` is the working database. Every change is written there synchronously, the moment it happens. (Not IndexedDB: iPhones can drop an app's IndexedDB connection after it has been in the background, and saves then fail until a reload.)
- Firestore is the synced copy, opened with plain `getFirestore(app)` like Hours. Changes are pushed in the background and pulled when they arrive from another device. On a new phone, signing in brings everything back.
- The Firebase SDK is loaded with dynamic `import()`, so the app still starts when the SDK cannot be fetched.
- The service worker precaches the app shell and the three SDK files and serves cache-first, so a launch never waits on the network.
- Nothing may ever block counting: not sign-in, not sync, not a failed network call.

## 4. Files and who writes them

| File | Owner | What it is |
|---|---|---|
| `public/pay.js` | logic | Pure pay engine and local-date helpers. No DOM, no Firebase, no storage. |
| `public/holidays.js` | logic | Victorian public holidays, 2026 and 2027, from the official list. |
| `public/model.js` | logic | Pure operations on the day and config documents (new visit, tap, undo, counts, legs, report text). |
| `tests/pay.test.mjs`, `tests/model.test.mjs` | logic | `node --test tests/` |
| `public/store.js` | sync | Local database + sync orchestration. Storage and remote are injected so it can be tested in Node. |
| `public/remote-firebase.js` | sync | The Firebase adapter (auth + Firestore), SDK loaded by dynamic import. |
| `tests/store.test.mjs` | sync | Sync tests with a fake storage and a fake remote. |
| `.firebaserc`, `firebase.json` | shell | Same shape as Hours. |
| `public/firebase-config.js` | shell | Same config values as `hours/public/firebase-config.js` (copy the file, rewrite only the comments). |
| `public/manifest.webmanifest`, `public/sw.js` | shell | Manifest; precaching service worker (section 9). |
| `public/icon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | shell | App icon in the family style. |
| `.claude/launch.json`, `README.md`, `tools/` | shell | Local preview config, short readme, any icon-generation script. |
| `public/index.html`, `public/styles.css`, `public/app.js` | interface | All screens and wiring. |

## 5. Data model

Conventions, everywhere:

- Dates are **local calendar dates** as `"YYYY-MM-DD"`, built from local `getFullYear/getMonth/getDate`. Never use `toISOString()` to get a date: in Melbourne it moves a morning to the previous day.
- Times of day are local `"HH:MM"` (24-hour). Instants are epoch milliseconds.
- Money is **integer cents**. Km is **integer tenths of a km** (12.4 km → `124`). Durations are integer minutes. Typed text is converted by string handling, never by floating-point multiplication (`19.4 * 100` is `1939.9999999999998` in JavaScript).
- Firestore cannot store an array inside an array and rejects `undefined`. Documents must survive `JSON.parse(JSON.stringify(doc))` unchanged.
- Fields are only ever added, never renamed. Every document carries `v: 1`.
- Only facts are stored (times, taps, km, amounts, rates). Totals are never stored; they are worked out fresh every time.

### Config — Firestore `tastings_config/main`, localStorage `tastings:config`

```js
{
  v: 1,
  updatedAt: 0,                // ms of the last local edit; 0 = untouched defaults
  homeAddress: "",
  places: [ { id: "p_lz4k2a", name: "BWS Northcote", address: "", lastUsed: 0, archived: false } ],
  kmMemory: { "home>p_lz4k2a": { tenths: 124, checkedOn: "2026-11-14", checkedTime: "09:40", via: "", stale: false } },   // ordered pair; A>B and B>A are separate
  rateSets: [ { from: "2026-07-01", weekday: 3476, evening: null, eveningFrom: "18:00",
                saturday: 4172, sunday: 4867, holiday: 6953, km: 100 } ],
  eveningAsked: false,
  payPeriod: { days: 7, anchor: "2026-09-21" },   // anchor = first day of some pay period (a Monday)
  roundMin: 15,                // step used when pre-filling paid times; no settings screen for it in v1
  avoidTolls: true,            // trips are measured on toll-free routes (tolls are not reimbursed)
  holidaysAdded: [ { date: "2026-12-24", name: "My extra day" } ],
  holidaysRemoved: [ "2026-11-03" ]
}
```

`"home"` is the reserved place id for home. Place ids are `"p_" + base36 timestamp`. Changing the home address or a store's address sets `stale: true` on every `kmMemory` entry that touches it.

### Day — Firestore `tastings_days/{date}`, localStorage `tastings:day:{date}`

```js
{
  v: 1,
  date: "2026-11-14",
  updatedAt: 1794700000000,
  paidAs: null,                // null = automatic, or "weekday" | "saturday" | "sunday" | "holiday"
  visits: [ {
    id: "v_lz4k2a",
    placeId: "p_lz4k2a", placeName: "BWS Northcote",   // name copied so history survives a rename
    startedAt: 1794700000000,  // ms when the tasting was started; null for a tasting entered by hand
    endedAt: null,             // ms when it was finished; null while running
    paidStart: "10:00", paidEnd: "",   // "" until finished; always editable
    startManual: false, endManual: false,   // true once the user set that time by hand; a manual time is never overwritten
    breakMin: 0,
    tapT: [12, 31, 40],        // seconds since startedAt, one per tap; the log only ever grows
    tapK: "SNs",               // same length as tapT. S = took a sample, N = no / ignored; lower case (s, n) = undone: kept, not counted
    adjS: 0, adjN: 0,          // hand corrections, may be negative
    note: ""
  } ],
  legs: [ { from: "home", to: "p_lz4k2a", fromName: "Home", toName: "BWS Northcote",
            tenths: 124, checkedOn: "2026-11-14", checkedTime: "09:40", via: "", skip: false } ],
            // tenths, checkedOn and checkedTime are null until known; skip = "not driven"
  parking: [ { id: "k_lz4k2a", cents: 650, note: "", visitId: "v_lz4k2a" } ]   // visitId may be null
}
```

Rules:

- `sampled = count of upper-case "S" in tapK + adjS`, `declined = count of upper-case "N" + adjN`, `talked = sampled + declined`. None may go below 0.
- **Undo** turns the newest counted tap to lower case. **Put back** turns the first undone tap after the last counted one back to upper case. Taps are never deleted, except by `dropLateTaps` and by cancelling a tasting before its first count.
- A visit is **running** when `startedAt !== null && endedAt === null`. At most one visit is running at a time across all days. A visit belongs to the date it started on.
- **Legs** are derived, never added by hand. Order the day's visits by `paidStart` (then `startedAt`); the chain is home → first place → … → last place → home. Two visits in a row at the same place make no leg. A day with no visits has no legs. When rebuilding, keep `tenths`/`checkedOn` from an existing leg with the same `from>to`; otherwise copy them from `kmMemory` (unless that entry is stale); otherwise `null`. Keep `skip` the same way. A skipped leg counts 0 km and is not "missing".
- Each day keeps its own copy of a leg's km, so re-checking a drive later never rewrites past days.

## 6. Module APIs

### `public/pay.js` (pure)

```js
export const DEFAULT_RATE_SET            // the rate set shown in section 5
export function todayISO(d = new Date()) // local date
export function parseISO(s), addDays(s, n), weekdayOf(s)   // weekdayOf: 0 = Sunday … 6 = Saturday
export function rateSetFor(date, rateSets)     // latest set whose `from` <= date, else the earliest set
export function dayKind(date, holidays, paidAs) // "weekday" | "saturday" | "sunday" | "holiday"; holidays is a Map(date → name)
export function minutesBetween(start, end)      // "HH:MM" → minutes; 0 if either is missing or end <= start. Never wraps past midnight.
export function addMinutes(hhmm, n)             // clamped to 00:00–23:59
export function roundHHMM(hhmm, stepMin)        // nearest step; step 0 returns it unchanged
export function hhmmOf(ms)                      // local "HH:MM" of an instant
export function visitLines(visit, date, config, holidays, paidAs)
        // → [ { kind: "weekday"|"evening"|"saturday"|"sunday"|"holiday", minutes, rate, cents } ]; [] if no paid time yet
export function visitProblems(day, visit)       // → subset of ["noEnd", "endBeforeStart", "tooLong", "overlap"]
export function dayTotals(day, config, holidays)
        // → { lines, hoursMin, hoursCents, kmTenths, kmCents, parkingCents, totalCents, missingKm, running, problems }
export function periodOf(date, payPeriod)       // → { start, end } inclusive
export function periodTotals(days, config, holidays, start, end)
        // → same shape as dayTotals, plus days: [ { date, hoursMin, kmTenths, totalCents, missingKm, running, problems } ]
export function money(cents)      // "$1,234.56"
export function hoursDec(min)     // "7.00"
export function hm(min)           // "7 h" / "7 h 30 m"
export function kmText(tenths)    // "12.4"
```

Pay rules:

- Paid minutes of a visit = `minutesBetween(paidStart, paidEnd) - breakMin`, never below 0.
- Kind of day, in order: `paidAs` if set, then public holiday, Sunday, Saturday, weekday. One rate per minute, never stacked. `paidAs` sets the kind of day only.
- **Weekday evening**: whenever the kind is weekday and the rate set's `evening` is a number, minutes after `eveningFrom` are their own `"evening"` line at that rate. An unpaid break comes off the daytime part first.
- `lines` are grouped by kind and rate: minutes are summed, then `cents = Math.floor((minutes * rate + 30) / 60)` **once per line** (round half up, in whole numbers), the way a payslip does. The same rule is used for one visit, one day and one period, so the sum of the days can differ from the period by a cent; the app never shows a sum of days. Never build a rate from a base rate and a percentage (`27.81 * 1.5` gives 41.71, one cent short).
- `kmCents = Math.round(kmTenths * rate.km / 10)`, grouped by km rate. A leg with `tenths === null` counts 0 and increments `missingKm`.
- `totalCents = hoursCents + kmCents + parkingCents`.
- Problems: `noEnd` (finished visit with no paid end), `endBeforeStart`, `tooLong` (more than 10 hours), `overlap` (paid time overlaps another visit that day). A visit with a problem contributes 0 minutes.

### `public/holidays.js`

```js
export const HOLIDAYS_VIC      // [ { date, name } ] — the official Victorian list for metropolitan Melbourne, 2026 and 2027, exactly as published (including extra weekday holidays)
export const HOLIDAYS_THROUGH  // "2027-12-31"
export function holidayMap(config)   // Map(date → name) = built-in list + holidaysAdded - holidaysRemoved
```

Transcribe the dates from the official Victorian Government list and the Fair Work Ombudsman list, give both source URLs in a comment, and check every date's weekday. If a date is not yet fixed (for example the Friday before the AFL Grand Final 2027), leave it out and say so in the comment.

Two independent checks on 13 Nov 2026 read the Fair Work lists as: 2026 — 25 Sep (Friday before the AFL Grand Final), 3 Nov (Melbourne Cup), 25, 26 and 28 Dec; 2027 — 1 Jan, 26 Jan, 8 Mar, 26–29 Mar, 25 Apr, 14 Jun, 2 Nov, 25–28 Dec, with the 2027 Grand Final Friday not yet fixed. Use this only as a cross-check: confirm every date against the source, and include the whole of 2026.

### `public/model.js` (pure)

```js
export function defaultConfig()
export function withConfigDefaults(cfg)          // fills missing fields; never drops unknown ones
export function emptyDay(date)
export function newPlace(name, now)              // → place
export function newVisit(place, now, roundMin)   // running visit; paidStart = start time rounded to the step
export function manualVisit(place, paidStart, paidEnd)   // startedAt null, endedAt set, both times manual
export function startedEarlier(visit, minutes, roundMin) // paidStart = (start time − minutes) rounded; startManual = true
export function addTap(visit, kind, now)         // kind "S" | "N"
export function undoTap(visit)                   // lower-cases the newest counted tap → { kind, t }, or null
export function redoTap(visit)                   // upper-cases the first undone tap after the last counted one → { kind, t }, or null
export function counts(visit)                    // → { sampled, declined, talked }
export function lastTapMs(visit)                 // instant of the last tap, or null
export function suggestPaidEnd(visit, now, roundMin)
        // → { paidEnd, from: "now" | "lastCount" }: the last count if it was more than 20 minutes before `now`, else `now`; rounded; always after paidStart
export function lateTaps(visit, gapMin = 20)     // → number of taps at the end that follow a gap of gapMin or more (pocket taps)
export function dropLateTaps(visit, gapMin = 20)
export function finishVisit(visit, now, roundMin)// sets endedAt; fills paidEnd from suggestPaidEnd only if it is empty and not manual
export function reopenVisit(visit)               // endedAt = null (count more); paid times are kept
export function rebuildLegs(day, config)         // mutates day.legs per section 5
export function setLegKm(day, config, index, tenths, { date, time, remember })   // remember=false changes this day only
export function setLegSkip(day, index, skip)     // "not driven"
export function lastLengthAt(days, placeId)      // paid minutes of the most recent finished tasting at that store, or null
export function setAddress(config, placeId, address)   // also marks the kmMemory entries that touch it stale
export function mapsUrl(fromAddress, toAddress, avoidTolls = true)
        // https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=driving, plus &avoid=tolls when avoidTolls ; null if either address is empty
export function reportText(day, visit)           // the text for "Copy report" (section 7)
export function parseKm(text)                    // "12,4" | "12.4" | "12" → 124 / 120 ; null if invalid ; range 0–9999 tenths
export function parseMoney(text)                 // "6.5" → 650 ; null if invalid
```

### `public/store.js`

```js
export function createStore({ storage = localStorage, prefix = "tastings:", now = Date.now, debounceMs = 1500,
                              fillConfig, newDay } = {})
// store.js does not import model.js: app.js passes fillConfig = model.withConfigDefaults and newDay = model.emptyDay.
// Timers and the online signal are injectable too, so the tests run in Node without waiting.
store.getConfig()            // config with defaults filled in; treat as read-only
store.getDay(date)           // day or null; treat as read-only
store.listDays()             // every day held locally
store.saveConfig(mutator)    // mutator(draft) edits a deep copy; then: stamp updatedAt, write storage, mark dirty, notify, schedule a push
store.saveDay(date, mutator) // same for a day; creates the day if it is missing
store.runningVisit()         // { date, visit } | null
store.subscribe(fn)          // fn() after any local or remote change; returns an unsubscribe function
store.attachRemote(remote)   // start pulling and pushing
store.detachRemote()
store.ensureRange(start, end)// with a remote attached, fetch days older than the live window once (for old pay periods)
store.flush()                // push now (pagehide, visibilitychange → hidden)
store.status()               // { remote: "none"|"connecting"|"online"|"offline", dirty: n, lastSync: ms|null, storageOk: boolean }
```

Storage keys: `{prefix}config`, `{prefix}day:{date}`, `{prefix}dirty` (JSON array of `"config"` / `"day:{date}"`), `{prefix}owner` (`"1"` once the owner has signed in on this device), `{prefix}ui` (last tab and viewed day, section 7). Demo mode uses the prefix `tastings-demo:` and never attaches a remote.

Remote adapter (implemented by `remote-firebase.js`, faked in the tests):

```js
remote.pushDoc(kind, id, data)        // kind "config" | "day". Promise resolves once the server has the write.
remote.subscribe(kind, onChange, opts)// onChange([ { id, data } ]) for documents as the server has them (not local echoes); returns unsubscribe.
                                      // For "day", opts.since = "YYYY-MM-DD": only days on or after it (the live window is the last 120 days).
remote.fetchDays(start, end)          // Promise<[ { id, data } ]> for older days, on demand
```

Sync rules:

- **Save**: write the document to storage synchronously inside `saveDay`/`saveConfig`, before notifying. If `setItem` throws, keep the change in memory and report `storageOk: false`.
- **Push**: for every dirty key, `pushDoc` a JSON clone of the current document, at most one push in flight per key. When it resolves, clear the dirty mark only if the document's `updatedAt` is still the one that was pushed; if it changed meanwhile, push again. A failed push stays dirty. Retry on the next change, on the window `online` event, on attach, and every 60 seconds while anything is dirty. A push that has not settled after 30 seconds reports `remote: "offline"` and stays in flight.
- **Pull** (last write wins by `updatedAt`): no local copy, or remote is newer → take the remote document and clear its dirty mark. Remote is older → keep local and mark it dirty. Equal → nothing.
- **Counts are never lost to a pull**: when a newer remote day replaces a local one, any visit present in both whose local tap log is longer than the remote one and starts with it keeps the local `tapT`/`tapK`. The merged day is then stamped with a fresh `updatedAt` and marked dirty.
- The store never deletes a document.

### `public/remote-firebase.js`

```js
export async function connectFirebase({ onUser })   // → { signIn, signOut, remote }
```

- Dynamic-import `firebase-app.js`, `firebase-auth.js`, `firebase-firestore.js` (10.14.1) and `./firebase-config.js`. A failed import rejects; the caller treats that as offline and retries on the `online` event.
- Auth exactly as Hours: `initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver })`, `signInWithPopup(auth, new GoogleAuthProvider())`.
- A signed-in user whose email is not `OWNER_EMAIL` is signed out again; `onUser(null, "This app is for one account only.")`.
- Firestore exactly as Hours: `getFirestore(app)`.
- `pushDoc` → `setDoc(doc(db, "tastings_config", "main"), data)` or `setDoc(doc(db, "tastings_days", id), data)`.
- `subscribe` → `onSnapshot` on the config document, or on `query(collection(db, "tastings_days"), where("date", ">=", since))`; pass on only documents with `metadata.hasPendingWrites === false`.
- `fetchDays` → `getDocs` with a `date` range.

## 7. Screens

Three tabs in a bottom bar (Today, Pay, Settings) plus a full-screen Counter and bottom sheets like Hours'. Plain words everywhere; the user is not technical.

### Start-up

1. `?demo` in the address: demo mode. No Firebase at all, prefix `tastings-demo:`, a visible "Demo" pill. If storage is empty, seed a home address and two stores with remembered km. Used for testing.
2. Otherwise, if `{prefix}owner` is set: show the app at once from local data and connect Firebase in the background. Owner signed in → `attachRemote`. Not signed in → a small bar "Sign in to sync" that never blocks anything. SDK could not load → status "Offline".
3. Otherwise: the sign-in gate, like Hours ("Sign in with Google"). On success set `{prefix}owner`, attach, show the app. On an iPhone in a Safari tab (not opened from the Home Screen) the gate first shows how to install: Share → Add to Home Screen → open Tastings from its icon, with a "Continue here anyway" link.
4. If a visit is running, open the Counter straight away. If it has been running for more than 14 hours, open its Finish sheet instead, saying it was left running.
5. Otherwise restore the last tab and viewed day from `{prefix}ui` if it was saved less than ten minutes ago (coming back from Google Maps can reload the app).
6. Register the service worker except on `localhost` / `127.0.0.1` (there only with `?sw`).

### Counter (full screen while a tasting runs)

Top to bottom:

- Head: store name and running time (left), **Lock** (right), and under them a full-width pink **Finish tasting** button (see section 0, v3).
- Status line: "Saved" with the sync state ("Synced", "Offline — saved on this phone", "Sign in to sync") and whether the screen will stay on ("Screen stays on" / "Screen will sleep"). A red bar "Not saved on this phone" if storage fails.
- Before the first count there is no separate bar any more: the fixed line below offers "started earlier / wrong store" and opens a sheet with those choices (see section 0, v3).
- **Undo** bar that names what it will remove ("Undo: took a sample 1:42 pm"). Tap again to go further back; after three undos in a row the next ones need a short hold. After an undo it reads "Removed: took a sample 1:42 pm — Put back" until the next count. No confirmation questions.
- Report band, live: **Talked to · Sampled · Rejected or ignored**. It sits between Undo and the count buttons so a slip from a count button cannot hit Undo.
- Two full-width count buttons filling all the remaining height, each at least 120px tall and showing its own big number: **No / ignored** (yellow, on top) and **Took a sample** (green, at the bottom). They never move. Keep them at least 24px clear of the bottom and side edges of the screen, on top of the safe-area insets.

Behaviour:

- One tap = one person. Count on `pointerdown` (not `click`), so a hurried jab counts and two quick taps count twice. If the phone cancels that touch (`pointercancel`, for example a swipe up from the bottom edge), remove that count again. The button visibly presses and flashes and its number bumps. `navigator.vibrate(15)` where it exists (not on iPhone).
- Every tap goes through `store.saveDay` at once.
- The screen cannot scroll, zoom, pull-to-refresh, select text or show a long-press menu (`touch-action: none` on the pad, `overscroll-behavior: none`, `user-select: none`). Use `100dvh` and safe-area insets. It must stay usable in landscape.
- Screen Wake Lock while the Counter is showing and not covered; request it again on every `visibilitychange` back to visible, and show the real state.
- **Lock**: a dark cover over the whole screen so pocket touches count nothing; **slide to unlock** (a hold can happen in a pocket). After **10 minutes with no count** the cover comes on by itself and the wake lock is released so the phone can sleep.
- **Finish**: one tap opens the Finish sheet. Nothing is lost by opening it.

### Finish sheet (also used to edit any tasting and to add one by hand)

- The three numbers in large type. Sampled and Rejected or ignored are number boxes with minus and plus either side (they change `adjS`/`adjN`; a typed number sets the adjustment); Talked to follows.
- If `lateTaps` finds counts after a gap of 20 minutes or more: "3 counts came after a 27-minute gap (1:25 pm) — remove them?".
- **Paid time** comes right under the numbers and the user confirms it: "Paid 10:00 – 14:00 = 4 h × $41.72 = $166.88". Start and finish are time inputs with −15 and +15 buttons. Length buttons set the finish from the start: the last length used at this store (if any), **3 h** and **4 h**; one is preselected when the measured length is within 20 minutes of it. When the suggestion came from the last count, say so ("Last count 12:58"). Tint the line amber when rounding moved a time by more than 5 minutes. The real tap times are shown in small print. Unpaid break: None, 15, 30, 45, 60.
- Problems are shown in red and keep the day "not final": finish at or before start, longer than 10 hours, overlaps another tasting that day.
- The pay working, live: "4 h × $41.72 (Saturday) = $166.88"; two lines when a weekday tasting is split at 6 pm.
- **Weekday hours after 6 pm**, asked while `eveningAsked` is false and a weekday tasting ends after `eveningFrom`: "Are weekday hours after 6 pm paid at a higher rate?" — "Yes — $41.72" (the Saturday figure; it is the retail award's weekday evening rate), "No — same rate", "Not sure yet". "Not sure yet" leaves `eveningAsked` false and shows both totals. The other two set the current rate set's `evening` and `eveningAsked`.
- Parking for this store: one dollar box (creates or updates the parking item linked to this visit).
- Note.
- Buttons: **Keep counting** (large, at the bottom, for a running tasting), **Count more** (for a finished tasting from today, when nothing else is running), **Copy report**, **Done**, and **Delete tasting** (hold for a second).
- Finishing a tasting with no counts that ran under five minutes asks "Discard this tasting?".
- Copy report text:

```
Tasting report — Sat 14 Nov 2026
Store: BWS Northcote
Time: 10:00 am – 2:00 pm
People talked to: 43
Samples given: 27
Rejected or ignored: 16
```

### Today (opens here when nothing is running)

- Date line with previous / next arrows, tap the date to pick any day, and a "Today" shortcut when viewing another day.
- **Paid as** chip set from the date and the holiday list, showing the reason: "Saturday · $41.72/h", "Public holiday: Boxing Day · $69.53/h". One tap opens the four choices to override it.
- **Start a tasting**: the saved stores as big rows, most recently used first; one tap starts the clock and opens the Counter. "New store" needs only a name; the address can wait. Live counting can only be started when viewing today; on other days only "Add a tasting by hand" is offered (store, paid start and finish, the two counts typed, parking).
- Tasting cards: store, paid times, hours, the three numbers, pay. Tap to open the Finish sheet for it.
- **Trips**: the legs, built by the app. Each row: from → to, a km box (already filled in, with the date it was last checked, when that drive is remembered), and a **Maps** link (a real `<a target="_blank" rel="noopener">`) that opens Google Maps on exactly that leg. If an address is missing the row offers "Add address" instead. A leg with no km is highlighted and the day shows "km missing". A remembered km marked stale shows "re-check". When a typed km differs from the remembered one, ask "Just this day" or "Remember"; ask to confirm a km that differs by more than 15% from the remembered value. Show when the km was checked ("checked 14 Nov, 9:40 am"). The Maps link is built with `config.avoidTolls`, and under the km box it says: "Toll-free route only — tolls are not paid back. If Google Maps says the route has tolls, switch on Avoid tolls there first." Each leg has a "Not driven" switch for days that do not follow the usual chain.
- **Parking**: the list and "Add parking" (amount, optional note), at any time, any number of items.
- **Day total**: hours at each rate, trips, parking, and the total "expected before tax", with the reasons it is not final (km missing, a tasting running, a time problem).
- A small sync line: "Synced 2 min ago" / "3 changes waiting to sync" / "Sign in to sync".

### Pay

- Week / Fortnight switch (writes `payPeriod.days`) and previous / next arrows; the period's dates as a label.
- One line per rate worked (hours as `7.00` × rate = amount), then Trips (km × rate), Parking, and the total "Expected before tax".
- Plain warnings that jump to the day: "1 trip has no km yet", "A tasting is still running", "A tasting has a time problem".
- The days in the period (date, hours, km, total); tap one to open it on Today.
- **Copy summary** (and Share where `navigator.share` exists).

### Settings

- **My places**: home address; stores (name and full street address with suburb, state and postcode); add, edit, archive.
- **Trips**: a "Toll-free routes only" switch, on by default (writes `avoidTolls`), with the tip: "Do this once in Google Maps so the km you read and the road you drive match: get directions, tap More, then Options, and switch on Avoid tolls."
- **My rates**: Weekday, Weekday after 6 pm (empty = same as weekday), Saturday, Sunday, Public holiday, Trip rate per km. v1 edits the latest rate set. The data model already allows dated sets; a "New rates from a date" screen is needed before July 2027 and is not part of v1.
- **Pay period**: week or fortnight, and the day a period starts.
- **Public holidays**: the built-in Victorian list, add a date, remove a date, a line saying holidays follow where you are based (not the store visited), and a warning when today is past `HOLIDAYS_THROUGH`.
- **Account**: signed-in email, sync status, Sign out, the build string.
- **App update**: the version, "Check for update" and, when one is ready, "Update now". Both are disabled offline and while a tasting is running. The page never deletes caches itself.

### iPhone details that matter

- Inputs use `font-size: 16px` or more, or the page zooms on focus. Km and money boxes use `inputmode="decimal"`.
- There is no browser back button in a Home Screen app: every sheet and screen has its own way out.
- No reliance on vibration or sound. Confirmation is visual.
- Returning from Google Maps may reload the app: it must come back to the same day with nothing lost.

## 8. Rates to start with

Weekday $34.76 · Saturday $41.72 · Sunday $48.67 · Public holiday $69.53 · Trips $1.00 per km, all per hour, effective `2026-07-01`. They are the user's own figures and all are editable. The app says "expected, before tax" and never "owed".

## 9. Service worker and hosting

- `sw.js`: `const VERSION = "tastings-v1"`. On install, fetch every shell file with `cache: "reload"` into the versioned cache (the install fails as a whole if any shell file fails, so a half-downloaded version is never used), plus, best effort, the three gstatic SDK files. Do **not** call `skipWaiting()` on install.
- On activate: delete old caches and `clients.claim()`.
- Fetch: same-origin GET → cache first (ignore the query string), then network, falling back to `/index.html` for navigations. `https://www.gstatic.com/firebasejs/…` → cache first, then network, storing the response. Everything else passes through untouched.
- Updating: a new version installs in the background and waits. Settings shows "Update now" when a worker is waiting; tapping it posts `{ type: "SKIP_WAITING" }`, and the page reloads on `controllerchange`. "Check for update" calls `registration.update()`. Today also shows a "New version ready — Update now" banner when a worker is waiting and nothing is running.
- The service worker only ever deletes caches whose names start with `tastings-`. No code calls `localStorage.clear()`.
- `VERSION` must be raised on every deploy; the readme says so.
- `firebase.json` and `.firebaserc`: the same shape and headers as Hours, with `"site": "tastings-jay-1609"` and project `your-project-id`.

## 10. Checks that must pass

- `node --test tests/` is green, also with `TZ=UTC` and `TZ=America/Los_Angeles`.
- Pay: Saturday 4 h = $166.88 · Sunday 3 h = $146.01 · public holiday 4 h = $278.12 · Saturday 4 h 05 = $170.36 · Friday 16:00–19:00 = $104.28 with no evening rate and $111.24 with the evening rate 4172 · three Sunday tastings of 3 h 15 in one period = $474.53 · a Saturday with 10:00–14:00 and 15:00–18:00, legs 12.4 + 8.7 + 15.1 km and $6.50 parking totals $334.74.
- Km and money: `parseKm("19.4") === 194`, `"35.3"` → 353, `"40.3"` → 403, `"8.7"` → 87, `"12,4"` → 124; 40.3 km at $1.00 = $40.30 and 8.7 km = $8.70 exactly; `parseMoney("4.35") === 435`.
- Maps link: `mapsUrl(a, b)` contains `travelmode=driving` and `avoid=tolls`; with `avoidTolls` false it has no `avoid`; both addresses are URL-encoded; an empty address gives `null`.
- Every leg is counted: a day with stores A then B has exactly three legs (home → A, A → B, B → home), three stores make four, and a leg with no km is flagged, never silently left out.
- Re-pricing: marking a finished day as a public holiday afterwards changes the tasting's pay and the day total.
- Undo and put back: `"SNS"` → undo → `"SNs"` → undo → `"Sns"` → put back → `"SNs"` → put back → `"SNS"`; a new count after an undo ends the chance to put back.
- Pull merge: a newer remote day that holds fewer taps for a running tasting does not remove the local taps.
- Dates: the built-in list decides whether `2026-12-26` and `2026-12-28` are holidays; a 9:55 am Saturday in Melbourne stays on its own date.
- Times: a finish at or before the start is a problem and pays nothing; nothing wraps past midnight.
- In demo mode in a phone-sized window: start a tasting, tap 50 times fast and get exactly 50, undo three, reload the page mid-tasting and return to the same Counter with the same numbers, finish, see the day total, type a km and see it remembered on a new day.
- Sync (fake remote): a change made offline is pushed after reconnect; a newer remote document replaces an older local one; an older remote document does not; a failed push is retried; a document changed while its push was in flight is pushed again.
