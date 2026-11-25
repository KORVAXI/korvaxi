# Pulse for Two

A food diary for two people: log what you eat and when, snap photos of meals,
see your week on a timeline, and track calories and protein toward a weight goal.
Runs as its own website on Netlify's free plan. No Claude subscription needed.

## Put it online (about 5 minutes)

1. Sign in at https://app.netlify.com and choose **Add new site → Import an existing project**.
2. Pick this GitHub repository and the branch that contains this folder.
3. Set **Base directory** to `pulse-for-two`. Leave the build command empty.
   The publish directory (`public`) and functions folder are read from `netlify.toml`.
4. Under **Environment variables**, add `APP_PASSCODE` with a code only you two know
   (use something longer than a PIN, e.g. three random words).
5. Deploy. Netlify gives you a link like `https://something.netlify.app`.

Food logs and photos are stored in Netlify Blobs, which every Netlify site includes.

## On your phones

- Open the link, enter the passcode, and tap who you are. The phone remembers you.
- iPhone: Share → **Add to Home Screen**. Android: menu → **Install app**.
- To switch person or log out: Body tab → **Log out or switch person**.
- To change the passcode, change `APP_PASSCODE` in Netlify and redeploy. Both phones
  will ask for the new one.

## Try it on a computer first

```
cd pulse-for-two
APP_PASSCODE=test node dev-server.mjs
```

Then open http://localhost:8888. This local copy keeps data in memory only.

## Files

- `public/index.html`: the app.
- `public/backend.js`: login screen and syncing with the server (checks for your partner's updates every 15 seconds).
- `lib/handler.mjs`: the API (passcode check, saving days and photos).
- `netlify/functions/api.mjs`: connects the API to Netlify.
