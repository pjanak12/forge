# Forge — private, offline gym tracker (iOS Home Screen web app)

Forge is a gym tracker that runs on your phone and stores everything on it. It's built as a Progressive Web App (PWA), so you install it to your iPhone Home Screen and it opens full-screen like a native app. There's no account and no server, it makes no network calls, and it works offline.

## Features

**People & privacy**
- **A profile for each person** on a device. Type your name and Forge remembers you; each profile's data is stored separately. An optional **PIN** keeps others out on shared phones.
- **Send a profile to another device** with a one-time transfer code or link. The data travels inside the code itself, never through a server.
- **Health profile**: weight, height, age and sex, plus injuries and surgeries (shoulder, lower back, knee, wrist/elbow, hip, ankle, neck, heart/blood pressure). Risky exercises are swapped for safer variations of the same movement, and you get warnings during workouts. Very high BMI or age 55+ favours low-impact options. This is not medical advice.

**Training**
- **Program library**: 18 proven routines (beginner full body, 5×5, upper/lower, PHUL-style, PPL, golden-era split, 5-day split, strength 4-day, dumbbell-only, calisthenics, core crusher with landmine, landmine full body, HIIT, cardio, 30-minute express, glutes). Filter by goal, days, equipment and level. Recommendations are based on your profile, and you can preview every day before adding a program.
- **Every routine gets a warm-up and a cool-down**: dynamic warm-up and stretching, logged separately from your training stats.
- **Automatic exercise rotation (training blocks)**: every 3–8 weeks (4 by default) Forge proposes new variations of each movement and a new rep focus (hypertrophy → strength → metabolic). You always review the changes, and you can undo a rotation.
- **Plateau coaching**: if you've had no new best on a lift for 3+ sessions, you get motivational nudges and one-tap fixes (+weight, rest-pause, drop set, +1 set, deload, swap variation).
- **Hypertrophy techniques**: drop sets, rest-pause, myo-reps, AMRAP, to-failure, slow eccentrics and lengthened partials, set per set or per routine, with the rest timer adjusted automatically.
- Guided workouts showing **"Exercise 3 of 8"** and set progress, with pre-filled weights, a rest timer, PR alerts and supersets.
- Progression engine (linear / double / added time) that shows the reason for each suggested weight.

**Guides & stats**
- **How-to guide for every exercise**: start/finish photos, a muscle map, step-by-step instructions, safety cues, suitable techniques and alternative variations. Exercises without photos show the muscle map instead.
- Muscle map (balance, fatigue, strength), monthly challenges, neglected-muscle nudges, structural balance, e1RM charts, heatmap and badges.
- **Body composition**: log smart-scale or body-composition scan readings (body fat, muscle, visceral fat, water, BMR, metabolic age…) with a photo of the printout, and see the changes and charts. BMI is calculated from your height.
- Backup, restore and merge; CSV export; import from Strong, Hevy and FitNotes.
- Adjustable text size, themes, accent colours, kg/lb.

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

- **Updating the app never touches user data.** Updates replace only the app files; workouts live in the phone's own storage (IndexedDB). Before any data-format upgrade the app also keeps an untouched safety snapshot.
- **Nobody can change the app except you.** Visitors only *read* the site; editing requires your GitHub login. Protect it with two-factor authentication. The page runs under a strict Content-Security-Policy (no external scripts, no outgoing connections), and imported files and codes are validated before use.

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
| `data.js` | Exercise library, movement patterns, safety cues, techniques, injury rules |
| `guide.js` + `img/` | Exercise photos and step-by-step instructions (public domain, [Free Exercise DB](https://github.com/yuhonas/free-exercise-db)) |
| `sw.js` | Offline cache |
| `manifest.webmanifest` | Install metadata and icons |

To make it part of an existing site, put the folder at a sub-path (e.g. `/gym/`). All paths are relative, so it works from any folder. The data is scoped to your domain, so it stays private to that origin.

## Limitations

- The rest-timer beep plays only while the app is open in the foreground (iOS suspends web apps in the background, and silent mode mutes web audio).
- There's no sync between devices, because there's no server. Use backup and restore to move data between them.
