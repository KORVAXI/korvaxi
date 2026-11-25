# Pulse for Two

A food diary for two people: log what you eat and when, snap photos of meals,
see your week on a timeline, and track calories and protein toward a weight goal.
Runs as its own website on Netlify's free plan. No Claude subscription needed.

## Put it online (about 5 minutes)

1. Sign in at https://app.netlify.com and choose **Add new site → Import an existing project**.
2. Pick this GitHub repository and the branch that contains this folder.
3. Set **Base directory** to `pulse-for-two`. Leave the build command empty.
   The publish directory (`public`) and functions folder are read from `netlify.toml`.
4. Under **Environment variables**, add:
   - `APP_PASSCODE`: a code only you two know (use something longer than a PIN, e.g. three random words).
   - `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: the keys for phone notifications.
     Make a pair with `npx web-push generate-vapid-keys`. Mark the private one as secret.
   - `VAPID_SUBJECT`: your site's address, e.g. `https://your-site.netlify.app`.
5. Deploy. Netlify gives you a link like `https://something.netlify.app`.

Food logs and photos are stored in Netlify Blobs, which every Netlify site includes.

## On your phones

- Open the link, enter the passcode, and tap who you are. The phone remembers you.
- iPhone: Share → **Add to Home Screen**. Android: menu → **Install app**.
- To switch person or log out: Me tab → **Log out or switch person**.
- Phone notifications: Me tab → **Phone notifications → On**. On iPhone this only works after
  adding the app to the Home Screen and opening it from there (iOS 16.4 or newer).
  You get your partner's reminders, hearts and planned meals, plus "Time to eat!" when your
  meal timer runs out (checked every 15 minutes, between 7am and 10pm).
- To change the passcode, change `APP_PASSCODE` in Netlify and redeploy. Both phones
  will ask for the new one.

## Try it on a computer first

```
cd pulse-for-two
APP_PASSCODE=test node dev-server.mjs
```

Then open http://localhost:8888. This local copy keeps data in memory only.

## Updating the app

The page is the same app that runs on claude.ai. To bring in a newer copy, replace `src/app.html`
and run `python3 tools/build.py`; it writes `public/index.html`.

## Files

- `src/app.html`: the app itself (same as the claude.ai version).
- `public/index.html`: built from `src/app.html` by `tools/build.py`.
- `public/sw.js`: shows notifications when the app is closed.
- `netlify/functions/remind.mjs`: checks everyone's meal timer every 15 minutes.
- `public/backend.js`: login screen and syncing with the server (checks for your partner's updates every 15 seconds).
- `lib/handler.mjs`: the API (passcode check, saving days and photos).
- `netlify/functions/api.mjs`: connects the API to Netlify.
