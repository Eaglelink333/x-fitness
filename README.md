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

### 4. Connect Apple Health (background sync)
The Shortcut posts to the `food-photo` function with `mode: "health"` and your personal **sync key**
(Plan → Connect Apple Health → Create my sync key), so nothing opens and it works from automations.
The in-app guide has copy buttons for the URL, the `Authorization` header and the key.
The older URL + Open URLs method below still works too.

### 4b. Older method: open a link
Websites can't read Apple Health directly, so an iOS Shortcut sends the data in. Full steps are in the app under **Plan → Connect Apple Health**. In short:

1. Shortcuts → new shortcut **Sync X-Fitness**.
2. **Find Health Samples** (Steps, today) → **Calculate Statistics** (Sum) → **Set Variable** `steps`.
3. Same again for **Active Energy** → `active`.
4. *(Optional)* Latest **Weight** sample → `weight`.
5. *(Apple Watch)* Same again for **Exercise Minutes** → `exercise`. It shows as "Apple Watch exercise" in Activity.
   *(Advanced)* Shortcuts usually can't list individual workouts. With a helper app such as Toolbox Pro (**Get Workouts**),
   send `workouts` as lines of `Name~Duration~Calories` and add `&workouts=[workouts]` to the URL; they replace the exercise entry.
   Re-running the Shortcut replaces that day's Watch entries rather than duplicating them.
6. **URL** `https://eaglelink333.github.io/x-fitness/?steps=[steps]&active=[active]&exercise=[exercise]&weight=[weight]` → **Open URLs**.
7. Automation → Time of Day (e.g. 12 pm, 5 pm and 8 pm daily) → Run Immediately → Sync X-Fitness.

The Shortcut opens the app in Safari, so sign in there once as well.

### 5. Photo calorie logging (optional, uses your Claude API key)
Tap **📷 Snap food, label or barcode** in the Food card:
- **Meal or drink:** Claude estimates each item, including oils and sauces.
- **Nutrition label:** Claude reads it and converts kJ to kcal, per serve and per pack.
- **Barcode:** Claude reads the number and the app looks it up on Open Food Facts.

You always confirm or adjust before anything is added. Each photo costs roughly 1–3 cents on Claude Opus 5.5.

Setup:
1. Supabase → **Edge Functions** → **Secrets** → add `ANTHROPIC_API_KEY` with your key from console.anthropic.com.
   The key stays on the server and never goes into this public repo.
2. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**. Name it `food-photo`,
   paste in [`supabase/functions/food-photo/index.ts`](supabase/functions/food-photo/index.ts), and click **Deploy**.
   Or with the CLI: `npx supabase functions deploy food-photo --project-ref vksjiczjmhhbyxvzaemf`.

Only signed-in users can use it, so nobody else can spend your API credit.

### 6. Coach and personal plan (same function, same key)
- **Coach tab:** chat with a nutritionist/PT that sees your targets, trend and last 14 days of logs.
  Chat history stays on the device you use it on.
- **Questionnaire:** shown after first setup, or from Plan → Personalise. Claude builds a weekly workout plan, meal ideas and tips.

## Two people, one app
Each person creates their own account, so data is kept separate. Choosing **Female** in setup switches to:
- a female workout plan (glutes/legs + dress-ready shoulders, back and arms, plus Pilates/core)
- protein at 1.6 g/kg, and a calorie floor of 1,200
- cycle-aware advice (a 1–2 kg jump before your period is water) and iron, calcium and craving tips
- wedding tips about dress fittings and final-week bloating

## How the numbers work
- **Calorie target** uses the Mifflin-St Jeor BMR × 1.4 (assuming ~10k steps a day), minus the deficit needed to reach the goal by the goal date.
  The deficit is capped at 1,000 kcal/day, and calories never go below 1,500 (men) or 1,200 (women).
- If the safe cap can't cover the full deficit, the **step goal** goes up to make up the difference. The Plan tab shows a realistic projected finish.
- **Status** (on track / ahead / behind) compares your 7-day average weight with the straight line from your start weight to your goal.
- **Protein** target: 1.8 g per kg of goal weight.

This is general guidance, not medical advice. ~1 kg/week is the upper end of a sensible rate.

## Local-only mode
If `config.js` has no Supabase key, the app runs without sign-in and saves to the browser's localStorage. This is handy for testing.
