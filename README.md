# X-Fitness

A simple iPhone-first web app for one goal: **lose 10 kg by 10 Jan 2027**.

- Daily weight log with a target line to the goal date
- Calorie log (name + kcal, with one-tap recent foods)
- Steps and active calories pulled from Apple Health (via an iOS Shortcut)
- Graphs for weight, calories and steps
- Daily advice on food and workouts, based on your own numbers
- Syncs between iPhone and desktop (Supabase)

Plain HTML/CSS/JS. No build step.

## Setup

### 1. Supabase (one time)
1. Open your Supabase project → **SQL Editor** → paste [`schema.sql`](schema.sql) → **Run**.
2. Go to **Project Settings → API**, copy the **anon public** key, and paste it into [`config.js`](config.js) as `supabaseAnonKey`.
   The anon key is meant to be public. Row-level security keeps your data private.
3. *(Optional, recommended)* Go to **Authentication → Sign In / Providers → Email** and turn off **Confirm email**, so you can sign in straight away.
4. Go to **Authentication → URL Configuration** and set **Site URL** to `https://eaglelink333.github.io/x-fitness/`.

### 2. Host on GitHub Pages
In the repo, go to **Settings → Pages → Build and deployment**. Set Source: *Deploy from a branch*, Branch: `main` / root.
After a minute the app is live at `https://eaglelink333.github.io/x-fitness/`.

### 3. Put it on your iPhone
Open the URL in Safari → **Share** → **Add to Home Screen**. Then open it and create your account.

### 4. Connect Apple Health
Websites can't read Apple Health directly, so an iOS Shortcut sends the data in. Full steps are in the app under **Plan → Connect Apple Health**. In short:

1. Shortcuts → new shortcut **Sync X-Fitness**.
2. **Find Health Samples** (Steps, today) → **Calculate Statistics** (Sum) → **Set Variable** `steps`.
3. Same again for **Active Energy** → `active`.
4. *(Optional)* Latest **Weight** sample → `weight`.
5. **URL** `https://eaglelink333.github.io/x-fitness/?steps=[steps]&active=[active]&weight=[weight]` → **Open URLs**.
6. Automation → Time of Day (e.g. 8 pm daily) → Run Immediately → Sync X-Fitness.

The Shortcut opens the app in Safari, so sign in there once as well.

## How the numbers work
- **Calorie target** uses the Mifflin-St Jeor BMR × 1.4 (assuming ~10k steps a day), minus the deficit needed to reach the goal by the goal date.
  The deficit is capped at 1,000 kcal/day, and calories never go below 1,500 (men) or 1,200 (women).
- If the safe cap can't cover the full deficit, the **step goal** goes up to make up the difference. The Plan tab shows a realistic projected finish.
- **Status** (on track / ahead / behind) compares your 7-day average weight with the straight line from your start weight to your goal.
- **Protein** target: 1.8 g per kg of goal weight.

This is general guidance, not medical advice. ~1 kg/week is the upper end of a sensible rate.

## Local-only mode
If `config.js` has no Supabase key, the app runs without sign-in and saves to the browser's localStorage. This is handy for testing.
