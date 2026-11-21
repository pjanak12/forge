# Forge — private, offline gym tracker (iOS Home Screen web app)

Forge is a gym tracker that runs on your phone and stores everything on it. It's built as a Progressive Web App (PWA), so you install it to your iPhone Home Screen and it opens full-screen like a native app. There's no account and no server, it makes no network calls, and it works offline.

## Features

- **Guided workouts.** Today's routine opens from your weekly plan. Weights are pre-filled from your last session, a rest timer runs with a beep, PRs are flagged as you log, and the screen stays awake.
- **Progression engine, per routine or per exercise.** Choose linear, double progression, added time, or "repeat last". Every suggestion shows why it was made (for example, "+2.5 kg: hit 3×5 last time"). Linear progression deloads 10% after 3 missed sessions.
- **Set types.** Warm-ups (excluded from records and progression), auto warm-up ramps, supersets, timed holds with a countdown timer, cardio (time + distance), body-weight and assisted exercises, and optional RPE/RIR per set.
- **Tools.** A plate calculator that uses the plates you own and a 1RM calculator with percentage tables.
- **Estimated 1RM per lift.** Uses the Epley formula, adjusted for RIR, and won't estimate above 12 reps. Includes a rep-max table and a history chart.
- **Structural balance.** Compares your lifts against classic strength ratios and names your weakest link.
- **Muscle map** with three views:
  - Balance: weekly sets per muscle against a 10–20 set target zone
  - Fatigue: estimated recovery
  - Strength: when each muscle was last trained and which lifts trained it
- **Stats.** A 12-month heatmap, weekly volume, sessions per week, week streaks, and 16 badges.
- **Body tracking.** A body-weight chart with a goal line (dots are green when you moved toward the goal, red when you moved away), plus measurements and body fat.
- **Weekly plan.** Choose Monday or Sunday as the first day. You can move a single day's session without changing the plan.
- **Five starter programs**, 140 built-in exercises, custom exercises, fuzzy search, and an equipment filter.
- **Editing.** You can edit past workouts, log workouts after the fact, repeat a workout, save a workout as a routine, and share a text summary.
- **Data.** JSON backup and restore (restore merges and never overwrites), CSV export, and import from **Strong, Hevy and FitNotes**.
- Dark, light and auto themes, 8 accent colours or a custom one, and kg/lb.

## Deploy to GitHub Pages (free, about 3 minutes)

1. Create a new repository on GitHub, e.g. `forge`. It can be private only on paid plans; otherwise make it public. The code is public, but **your data never leaves your phone**.
2. Upload every file in this folder (keep the `icons/` folder).
3. In the repo, go to **Settings → Pages → Build and deployment**. Set **Source: Deploy from a branch**, then **Branch: main / (root)**, and click **Save**.
4. After about a minute your app is live at `https://<your-username>.github.io/forge/`.

From the command line:
```bash
cd forge
git init && git add . && git commit -m "Forge gym tracker"
git branch -M main
git remote add origin https://github.com/<you>/forge.git
git push -u origin main
```

## Install on iPhone

1. Open the GitHub Pages URL in **Safari**.
2. Tap **Share** (□↑) → **Add to Home Screen** → **Add**.
3. Open Forge from the Home Screen. It runs full-screen and works offline from then on.

## Where your data lives (important)

- All data is stored in **IndexedDB inside the installed app** on your phone. Nothing is uploaded.
- iOS keeps the Home Screen app's storage **separate from Safari**. Data you entered in a Safari tab won't appear in the installed app; move it with Backup → Restore if needed.
- **If you delete the app from your Home Screen, iOS deletes its data.** Use *Settings → Back up (JSON)* regularly and save the file to Files or iCloud Drive. The app reminds you after 14 days without a backup.
- Home Screen apps get persistent storage, so iOS won't clear it the way it clears data for Safari sites you haven't visited in a while.

## Updating the app

Edit the files, then **bump `VERSION` in `sw.js`** (e.g. `forge-v1.0.1`) and push. The installed app picks up the new version the next time it's opened online (you may need to close and reopen it once). Updates never touch your data.

## Embedding in your own web app

Forge is plain HTML/CSS/JS with no build step and no dependencies:

| File | Purpose |
|---|---|
| `index.html` | App shell, iOS meta tags |
| `app.css` | All styles (CSS variables at the top for theming) |
| `app.js` | App logic, storage, views |
| `data.js` | Exercise library, muscle groups, strength ratios |
| `sw.js` | Offline cache |
| `manifest.webmanifest` | Install metadata and icons |

To make it part of an existing site, put the folder at a sub-path (e.g. `/gym/`). All paths are relative, so it works from any folder. The data is scoped to your domain, so it stays private to that origin.

## Limitations

- The rest-timer beep plays only while the app is open in the foreground (iOS suspends web apps in the background, and silent mode mutes web audio).
- There's no sync between devices, because there's no server. Use backup and restore to move data between them.
