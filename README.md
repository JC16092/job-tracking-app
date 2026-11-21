# Tastings

A small web app for the iPhone, made for running tasting stalls.

- Two big buttons count the people you talk to: sample given, or rejected / ignored.
- It keeps the paid hours, the km you drove and the parking for each day.
- It writes the report for each tasting and for the whole day, ready to share.
- It shows what a day and a pay period should pay, before tax, so you can check your payslip.

It works with no reception. Everything is saved on the phone first, then copied to your Google
account when there is a connection (the same Firebase project as Hours and Pace).

`SPEC.md` describes how it is built, in full.

## Try it on the Mac

1. Start the preview. In Claude, ask for the preview called `tastings`. Or in Terminal, from this folder:

   ```
   python3 -m http.server 5178 --directory public
   ```

2. Open <http://localhost:5178/?demo>

`?demo` is practice mode: made-up stores, nothing is synced, and your real numbers are not touched.
Without `?demo` it is the real app and asks you to sign in.

## Run the tests

In Terminal, from this folder:

```
node --test
```

Every line should start with a tick, and the summary at the end should say `fail 0`.
Type it exactly like that, with no folder name after it.

## Put it online

You run these yourself in Terminal, from this folder. Nothing goes online on its own.

**Once only: create the web address**

```
npx firebase-tools hosting:sites:create tastings-jay-1609 --project your-project-id
```

If it asks you to sign in first, run `npx firebase-tools login` and try again.

**Every time you put a new version online**

1. Open `public/sw.js` and find the line that starts `const VERSION = "tastings-v`. Raise the
   number at the end by one (v2 becomes v3, then v4, and so on). Change only the number.
   In `public/index.html`, raise the two `?v=` numbers to match, and in `public/app.js` the
   version in the line that starts `const BUILD =` (it is what Settings shows).
2. Run the tests (above).
3. Send the website, and only the website:

   ```
   npx firebase-tools deploy --only hosting --project your-project-id
   ```

4. Open the app on the phone, go to Settings, then App update. Tap **Check for update**, and when
   **Update now** appears, tap it. (Finish any tasting that is running first.)

Why step 1 matters: the phone keeps its own copy of the app so it can open without reception, and
it only fetches a new copy when that number has changed. If you forget, the phone stays on the old
version. Step 4 is what switches the phone over to the new copy.

The address is <https://tastings-jay-1609.web.app>

## First time on the iPhone

Do this at home on Wi-Fi.

1. Open <https://tastings-jay-1609.web.app> in **Safari**.
2. Tap the Share button, then **Add to Home Screen**.
3. Close Safari and open the app **from its new icon**. Always use the icon from now on: on an
   iPhone, the icon and a Safari tab each keep their own separate data.
4. Tap **Sign in with Google** and pick the account you use for Hours and Pace.
5. Leave the app open for a minute so it can save itself on the phone.

To check it worked: switch on Aeroplane Mode and open the app from the icon. It should open as usual.

If signing in fails with a message about the address not being allowed ("unauthorized domain"):
in the Firebase console open Authentication, Settings, Authorized domains, and add
`tastings-jay-1609.web.app`.

## Once a year: public holidays

The list of Victorian public holidays is in `public/holidays.js` and ends on the date in
`HOLIDAYS_THROUGH`. When the government publishes the next year's dates, add them to the list and
move that date forward, then put the new version online. Until then the app says the list is
ending, and a day can always be set by hand on Today (the purple button under the date) or added
in Settings.

## Never rename these

Your saved days are found by these names. Change one and the app looks in the wrong place, and your
history seems to disappear.

- The two Firestore collections: `tastings_days` and `tastings_config`.
- The storage prefix on the phone: `tastings:` (and `tastings-demo:` for practice mode).
- The names of the fields inside a saved day or the saved settings (`visits`, `tapK`, `paidStart`,
  `legs`, `tenths`, and the rest). New fields can be added. Existing ones are never renamed.
- The web address, once you use the app for real. The phone's copy of your data belongs to that
  address. Settle the name first (it is `site` in `firebase.json`, and appears in the commands
  above), then leave it alone.

The name on screen ("Tastings") is only a label. It can change at any time, in `public/index.html`
and `public/manifest.webmanifest`.

## What is in this folder

- `public/` is the app. This folder is what goes online.
- `tests/` and `tools/sw.test.mjs` are the checks that `node --test` runs.
- `tools/make-icons.py` draws the icon. Run `python3 tools/make-icons.py` to make the icon files again.
- The login rules for the database are not here. They live in `~/pace/firestore.rules`.

## Setup (Firebase)

This app uses Firebase (Google Auth + Firestore). To run your own copy:

1. Create a free Firebase project.
2. In `public/firebase-config.js`, replace the `YOUR_*` placeholders with your
   web app config, and set `OWNER_EMAIL` to the Google account allowed to sign in.
3. Update the email in `firestore.rules` to match.
4. Deploy: `firebase deploy`.

## License

[MIT](LICENSE)
