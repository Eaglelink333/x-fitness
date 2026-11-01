(() => {
'use strict';

const CFG = window.XF_CONFIG || {};
const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
const sb = CLOUD ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
const KCAL_PER_KG = 7700;
const BASE_STEPS = 10000;      // TDEE multiplier below assumes roughly this much walking
const ACTIVITY_FACTOR = 1.4;
const $ = (s) => document.querySelector(s);

let user = null;
let profile = null;
let days = {};
let viewDate = todayStr();
let currentView = null;
let chart = null;
let chartMode = 'weight';
let pendingHealth = null;

// ---------- dates & numbers ----------
function ymd(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function todayStr() { return ymd(new Date()); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function diffDays(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000); }
function fmtDate(s, o = { day: 'numeric', month: 'short' }) { return parseYmd(s).toLocaleDateString('en-AU', o); }
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const fmtInt = (n) => Math.round(n).toLocaleString('en-AU');
const numOrNull = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- storage ----------
const LOCAL_KEY = 'xf-data-v1';
function localRead() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch { return {}; } }
function localWrite() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ profile, days })); } catch {} }

async function loadAll() {
  if (!CLOUD) {
    const o = localRead();
    return { profile: o.profile || null, days: o.days || {} };
  }
  const [p, d] = await Promise.all([
    sb.from('profile').select('*').maybeSingle(),
    sb.from('days').select('*').order('date'), // '*' so a missing activities column can't break loading
  ]);
  if (p.error) throw p.error;
  if (d.error) throw d.error;
  const map = {};
  for (const r of d.data) map[r.date] = { weight: numOrNull(r.weight), steps: r.steps, active_cal: r.active_cal, foods: r.foods || [], activities: r.activities || [] };
  let prof = null;
  if (p.data) {
    const { user_id, ...rest } = p.data;
    prof = { ...rest, start_weight: +rest.start_weight, goal_weight: +rest.goal_weight, height_cm: +rest.height_cm, age: +rest.age };
    if (!prof.plan) { // plan saved on this device while the database lacked the column
      try { Object.assign(prof, JSON.parse(localStorage.getItem(PLAN_KEY())) || {}); } catch {}
    }
  }
  return { profile: prof, days: map };
}

const PLAN_KEY = () => 'xf-plan-' + (user?.id || 'local');

async function saveProfile() {
  if (!CLOUD) return localWrite();
  let { error } = await sb.from('profile').upsert({ user_id: user.id, ...profile });
  // Database not migrated for newer columns yet: keep the plan on this device and save the rest
  if (error && /name|plan|answers/.test(error.message)) {
    const { name, plan, answers, ...rest } = profile;
    try { localStorage.setItem(PLAN_KEY(), JSON.stringify({ plan, answers })); } catch {}
    ({ error } = await sb.from('profile').upsert({ user_id: user.id, ...rest }));
  }
  if (error) throw error;
}

async function saveDay(date) {
  if (!CLOUD) return localWrite();
  const d = days[date];
  const row = {
    user_id: user.id, date, weight: d.weight, steps: d.steps, active_cal: d.active_cal,
    foods: d.foods, activities: d.activities || [], updated_at: new Date().toISOString(),
  };
  let { error } = await sb.from('days').upsert(row);
  // Database not migrated for workouts yet: save everything else
  if (error && /activities/.test(error.message)) {
    const { activities, ...rest } = row;
    ({ error } = await sb.from('days').upsert(rest));
    if (!error && activities.length) toast('Workouts need a quick Supabase update to save (see README).');
  }
  if (error) toast("Couldn't save. Check your connection.");
}

const emptyDay = () => ({ weight: null, steps: null, active_cal: null, foods: [], activities: [] });
const getDay = (date) => ({ ...emptyDay(), ...days[date] });
const ensureDay = (date) => {
  days[date] ||= emptyDay();
  days[date].activities ||= [];
  return days[date];
};
const kcalOf = (date) => getDay(date).foods.reduce((s, f) => s + (+f.kcal || 0), 0);

// ---------- workouts ----------
// MET values from the Compendium of Physical Activities; burn counts only the extra above resting (MET - 1)
const ACTIVITIES = [
  { key: 'walk', label: 'Walking (brisk)', icon: '🚶', met: 4.3 },
  { key: 'run', label: 'Running', icon: '🏃', met: 9.8 },
  { key: 'tennis', label: 'Tennis', icon: '🎾', met: 7.3 },
  { key: 'gym', label: 'Gym (weights)', icon: '🏋️', met: 5.0 },
  { key: 'hiit', label: 'HIIT / class', icon: '🔥', met: 8.0 },
  { key: 'cycle', label: 'Cycling', icon: '🚴', met: 7.5 },
  { key: 'swim', label: 'Swimming', icon: '🏊', met: 6.0 },
  { key: 'hike', label: 'Hiking', icon: '⛰️', met: 6.0 },
  { key: 'dance', label: 'Dancing', icon: '💃', met: 5.0 },
  { key: 'yoga', label: 'Yoga / Pilates', icon: '🧘', met: 3.0 },
];
const activityOf = (key) => ACTIVITIES.find((a) => a.key === key) || ACTIVITIES[0];
const burnFor = (key, mins, kg) => Math.round(((activityOf(key).met - 1) * kg * mins) / 60 / 5) * 5;
const burnOf = (date) => getDay(date).activities.reduce((s, a) => s + (+a.kcal || 0), 0);

// ---------- macros (grams; only on items from photos, barcodes or recent foods that had them) ----------
const MACROS = ['protein', 'carbs', 'fat'];
const hasMacros = (f) => f.protein != null;
const macroText = (f) => (hasMacros(f) ? `P ${Math.round(f.protein)} · C ${Math.round(f.carbs)} · F ${Math.round(f.fat)} g` : '');

// Normalises a food entry; macros scale with kcal if you edited the calories
function foodItem(it, kcal = it.kcal) {
  const out = { name: String(it.name || 'Food').slice(0, 60), kcal: Math.round(kcal) };
  if (hasMacros(it) && it.kcal > 0) {
    const r = kcal / it.kcal;
    for (const m of MACROS) out[m] = Math.round((+it[m] || 0) * r);
  }
  return out;
}

function macroTotals(date) {
  const t = { protein: 0, carbs: 0, fat: 0, missing: 0 };
  for (const f of getDay(date).foods) {
    if (hasMacros(f)) for (const m of MACROS) t[m] += +f[m] || 0;
    else t.missing++;
  }
  return t;
}

// Protein from the plan, ~27% of calories from fat, carbs fill the rest
function macroTargets(pl) {
  const fat = Math.round((pl.kcal * 0.27) / 9);
  return { protein: pl.protein, fat, carbs: Math.max(50, Math.round((pl.kcal - pl.protein * 4 - fat * 9) / 4)) };
}

// ---------- maths ----------
function weighIns() {
  return Object.keys(days).sort().filter((d) => days[d].weight).map((d) => ({ date: d, w: +days[d].weight }));
}

// 7-day average smooths out daily water swings
function currentWeight(asOf = todayStr()) {
  const ws = weighIns().filter((x) => x.date <= asOf);
  const recent = ws.filter((x) => diffDays(x.date, asOf) < 7);
  if (recent.length) return avg(recent.map((x) => x.w));
  if (ws.length) return ws[ws.length - 1].w;
  return profile.start_weight;
}

function targetAt(date) {
  const p = profile;
  const t = clamp(diffDays(p.start_date, date) / Math.max(1, diffDays(p.start_date, p.goal_date)), 0, 1);
  return p.start_weight + (p.goal_weight - p.start_weight) * t;
}

function plan() {
  const p = profile;
  const w = currentWeight();
  const left = Math.max(1, diffDays(todayStr(), p.goal_date));
  const bmr = 10 * w + 6.25 * p.height_cm - 5 * p.age + (p.sex === 'm' ? 5 : -161);
  const tdee = bmr * ACTIVITY_FACTOR;
  const toLose = Math.max(0, w - p.goal_weight);
  const needed = (toLose * KCAL_PER_KG) / left;
  const floor = p.sex === 'm' ? 1500 : 1200;
  const deficit = Math.max(0, Math.min(needed, 1000, tdee - floor));
  const kcal = Math.round((tdee - deficit) / 10) * 10;
  const kcalPerStep = 0.0005 * w;
  const shortfall = Math.max(0, needed - deficit);
  const extraSteps = Math.ceil(shortfall / kcalPerStep / 500) * 500;
  const stepGoal = Math.min(16000, BASE_STEPS + extraSteps);
  const dailyBurn = deficit + (stepGoal - BASE_STEPS) * kcalPerStep;
  const projected = w - (dailyBurn * left) / KCAL_PER_KG;
  const protein = Math.round((p.goal_weight * (p.sex === 'f' ? 1.6 : 1.8)) / 5) * 5;
  return { w, left, tdee, kcal, deficit, needed, floor, stepGoal, extraSteps, projected, protein, toLose, kcalPerStep, weekly: (dailyBurn * 7) / KCAL_PER_KG };
}

function status() {
  if (!weighIns().length) return { cls: '', label: 'Day 1: log your weight' };
  const d = currentWeight() - targetAt(todayStr());
  if (d <= -0.3) return { cls: 'good', label: `Ahead by ${fmt1(-d)} kg`, d };
  if (d <= 0.4) return { cls: 'good', label: 'On track', d };
  if (d <= 1.5) return { cls: 'warn', label: `Behind by ${fmt1(d)} kg`, d };
  return { cls: 'bad', label: `Behind by ${fmt1(d)} kg`, d };
}

// Linear fit over the last 14 days of weigh-ins
function trend() {
  const t = todayStr();
  const ws = weighIns().filter((x) => diffDays(x.date, t) <= 14 && x.date <= t);
  if (ws.length < 5 || diffDays(ws[0].date, ws[ws.length - 1].date) < 5) return null;
  const xs = ws.map((x) => diffDays(t, x.date)), ys = ws.map((x) => x.w);
  const mx = avg(xs), my = avg(ys);
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const now = my - slope * mx;
  return { perWeek: slope * 7, atGoal: now + slope * diffDays(t, profile.goal_date) };
}

// ---------- advice ----------
// Female plan leans on glutes/legs plus shoulders, back and arms for the dress
const WORKOUTS_F = [
  { d: 'Sun', icon: '🧘', t: 'Rest day. Easy walk, yoga or a 20 min stretch.' },
  { d: 'Mon', icon: '🍑', t: 'Lower body: Hip thrust 3×10, Goblet squat 3×10, Romanian deadlift 3×10, Walking lunges 3×10/leg.' },
  { d: 'Tue', icon: '🚶‍♀️', t: 'Cardio: 45 min brisk walk or incline treadmill (10–12% at ~5 km/h).' },
  { d: 'Wed', icon: '💪', t: 'Upper body (dress-ready arms & back): Shoulder press 3×10, Lat pulldown 3×10, Seated row 3×12, Lateral raise 3×12, Tricep pushdown 3×12.' },
  { d: 'Thu', icon: '🔥', t: 'Pilates or core + intervals: 20 min core/Pilates, then 8 × (1 min hard / 1 min easy) on bike or rower.' },
  { d: 'Fri', icon: '🏋️‍♀️', t: 'Full body: Squat 3×10, Push-ups (knees fine) 3×8–12, Single-arm row 3×10, Glute bridge 3×15, Plank 3×30s.' },
  { d: 'Sat', icon: '⛰️', t: 'Active day: 60+ min hike, dance class, swim or long walk with a friend.' },
];

const WORKOUTS_M = [
  { d: 'Sun', icon: '🧘', t: 'Rest day. Easy 30–45 min walk and a stretch.' },
  { d: 'Mon', icon: '🏋️', t: 'Strength A: Squat 3×8–10, Bench or push-ups 3×8–10, Row 3×10, Plank 3×40s.' },
  { d: 'Tue', icon: '🚶', t: 'Cardio: 45 min brisk walk or incline treadmill (10–12% at ~5 km/h).' },
  { d: 'Wed', icon: '🏋️', t: 'Strength B: Romanian deadlift 3×8–10, Overhead press 3×8–10, Lat pulldown 3×10, Lunges 3×10/leg.' },
  { d: 'Thu', icon: '🔥', t: 'Intervals: 10 min warm-up, then 10 × (1 min hard / 1 min easy) on bike, rower or run.' },
  { d: 'Fri', icon: '🏋️', t: 'Strength A again. Try to beat Monday by a rep or a little weight.' },
  { d: 'Sat', icon: '⛰️', t: 'Active day: 60+ min hike, swim, sport or long walk. Something fun.' },
];

const FOOD_RULES = [
  { icon: '🥩', t: 'Build every meal around protein: chicken, fish, eggs, Greek yoghurt, lean mince or tofu. It keeps you full and protects muscle.' },
  { icon: '🥦', t: 'Fill half your plate with veg or salad. It is high volume and low calorie.' },
  { icon: '💧', t: 'Drink 2–3 L of water a day. Have a big glass before each meal.' },
  { icon: '🍺', t: 'Liquid calories add up fast: beer ~150, wine ~120 per glass, flat white ~120, juice ~110. Cut or swap them for zero-sugar drinks.' },
  { icon: '📝', t: "Log food as you eat it, not at the end of the day. If you're unsure of a number, guess high." },
  { icon: '🫒', t: 'Measure oils, butter and sauces. 1 tbsp of oil is ~120 kcal and easy to miss.' },
  { icon: '🍽️', t: 'Eating out: grilled over fried, sauce on the side, skip the bread and pick one treat (not drinks + dessert + chips).' },
  { icon: '🍫', t: 'Snack swaps: protein yoghurt, jerky, fruit, rice cakes or popcorn instead of chips and chocolate.' },
  { icon: '😴', t: 'Sleep 7–8 hours. Short sleep raises hunger hormones the next day.' },
  { icon: '🔁', t: 'Repeat a few go-to meals. Fewer decisions means fewer slip-ups.' },
  { icon: '📅', t: 'Weekends undo weeks. Plan Saturday and Sunday meals in advance.' },
  { icon: '⏱️', t: 'Eat slowly. Taking ~20 minutes per meal gives your fullness signals time to kick in.' },
];

const FOOD_RULES_F = [
  { icon: '🩸', t: 'Get enough iron while dieting: red meat 2–3×/week, spinach, lentils. Pair plant iron with vitamin C (capsicum, citrus) so it absorbs better.' },
  { icon: '🥛', t: 'Keep calcium up with Greek yoghurt, milk, cheese or calcium-fortified alternatives. It matters more on lower calories.' },
  { icon: '🌙', t: 'Cravings often spike the week before your period. Plan a 150–200 kcal treat (e.g. a few squares of dark chocolate) instead of fighting it.' },
];

const isF = () => profile?.sex === 'f';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function workoutIcon(title) {
  const t = title.toLowerCase();
  const map = [[/rest|recover/, '🧘'], [/yoga|pilates|stretch|mobility/, '🧘'], [/run|jog/, '🏃'], [/walk|steps/, '🚶'], [/tennis/, '🎾'],
    [/swim/, '🏊'], [/cycl|bike|spin/, '🚴'], [/hiit|interval|circuit/, '🔥'], [/hike/, '⛰️'], [/dance/, '💃'], [/glute|lower|leg/, '🍑'],
    [/strength|upper|full|weights|gym|body/, '🏋️']];
  return (map.find(([re]) => re.test(t)) || [, '💪'])[1];
}
// Claude-built week if there is one (indexed Sun..Sat like Date.getDay), else the built-in plan
function workouts() {
  const week = profile?.plan?.week;
  if (week?.length) {
    const fallback = isF() ? WORKOUTS_F : WORKOUTS_M;
    return DAY_NAMES.map((d, i) => {
      const w = week.find((x) => x.day === d);
      return w ? { d, icon: workoutIcon(w.title), t: `${w.title}: ${w.details}` } : fallback[i];
    });
  }
  return isF() ? WORKOUTS_F : WORKOUTS_M;
}
const foodRules = () => [
  ...(profile?.plan?.tips || []).map((t) => ({ icon: '✨', t })),
  ...(isF() ? [...FOOD_RULES, ...FOOD_RULES_F] : FOOD_RULES),
];

function advice() {
  const t = todayStr(), pl = plan(), st = status(), out = [];
  const today = getDay(t), yest = getDay(addDays(t, -1));
  const eaten = kcalOf(t), yKcal = kcalOf(addDays(t, -1));

  const outfit = isF() ? 'dress' : 'suit';
  if (pl.left <= 7) out.push({ icon: '💍', t: isF()
    ? `Final week. Keep calories steady, cut salt, fizzy drinks and alcohol to reduce bloating, drink plenty of water and sleep well. Don't crash diet now.`
    : `Final week. Keep calories steady, go easy on salt and alcohol, drink plenty of water and sleep well. Don't crash diet now.` });
  else if (pl.left <= 28) out.push({ icon: '🪡', t: `Final ${outfit} fitting is usually 2–3 weeks before the day. Aim to be near your goal by then, and keep your weight steady afterwards so the fit stays perfect.` });

  if (!today.weight) out.push({ icon: '⚖️', t: 'Weigh in this morning, after the toilet and before you eat or drink.' });
  else if (yest.weight && today.weight - yest.weight >= 0.5) out.push({ icon: '🧂', t: isF()
    ? `Up ${fmt1(today.weight - yest.weight)} kg overnight. That's water, not fat: salt, carbs or your cycle (1–2 kg in the week before your period is normal). Trust the 7-day average.`
    : `Up ${fmt1(today.weight - yest.weight)} kg overnight. That's almost always water and salt, not fat. Trust the 7-day average.` });

  if (yKcal > pl.kcal + 250) out.push({ icon: '↩️', t: `Yesterday was ${fmtInt(yKcal - pl.kcal)} kcal over. Don't skip meals to make up for it. Just hit today's target and add a 30 min walk.` });

  if (eaten === 0) out.push({ icon: '🍳', t: `Target today: ${fmtInt(pl.kcal)} kcal and ${pl.protein} g protein. Start with a protein breakfast, e.g. 3 eggs + toast, or Greek yoghurt + berries.` });
  else if (eaten <= pl.kcal) out.push({ icon: '🍽️', t: `${fmtInt(pl.kcal - eaten)} kcal left today. Make the next meal lean protein + veg.` });
  else out.push({ icon: '🛑', t: `${fmtInt(eaten - pl.kcal)} kcal over today. Kitchen's closed. Herbal tea, water, or a walk if you're hungry.` });

  const proteinLeft = pl.protein - macroTotals(t).protein;
  if (today.foods.some(hasMacros) && proteinLeft > 30) out.push({ icon: '🥩', t: `${Math.round(proteinLeft)} g protein to go. Easy wins: chicken breast (~45 g), a tin of tuna (~25 g), 200 g Greek yoghurt (~20 g).` });

  if (today.steps == null) out.push({ icon: '👟', t: `Step goal: ${fmtInt(pl.stepGoal)}. Run the "Sync X-Fitness" Shortcut to pull steps from Apple Health.` });
  else if (today.steps < pl.stepGoal) {
    const mins = Math.ceil((pl.stepGoal - today.steps) / 110 / 5) * 5;
    out.push({ icon: '👟', t: `${fmtInt(pl.stepGoal - today.steps)} steps to go. That's about a ${mins} min walk.` });
  } else out.push({ icon: '✅', t: `Step goal smashed: ${fmtInt(today.steps)} steps.` });

  const w = workouts()[new Date().getDay()];
  out.push({ icon: w.icon, t: `Today's workout: ${w.t}` });

  if (st.cls === 'warn' || st.cls === 'bad') out.push({ icon: '🎯', t: 'Behind the line. This week: zero alcohol, no liquid calories, and log every bite. That alone usually closes the gap.' });
  else if (st.d != null && st.d <= -0.3) out.push({ icon: '🙌', t: "Ahead of schedule. Keep calories where they are and don't eat back your progress." });

  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const rules = foodRules();
  out.push(rules[dayOfYear % rules.length]);
  return out;
}

// ---------- views ----------
function show(view) {
  currentView = view;
  for (const v of ['auth', 'setup', 'quiz', 'today', 'progress', 'plan']) $('#view-' + v).hidden = v !== view;
  const main = ['today', 'progress', 'plan'].includes(view);
  $('#tabs').hidden = !main;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  renderHeader();
  if (view === 'setup') renderSetup();
  if (view === 'quiz') renderQuiz();
  if (view === 'today') renderToday();
  if (view === 'progress') renderProgress();
  if (view === 'plan') renderPlan();
  window.scrollTo(0, 0);
}

function rerender() { if (currentView) show(currentView); }

function renderHeader() {
  $('.brand').textContent = profile?.name ? `Hi ${profile.name}` : 'X-Fitness';
  if (!profile) { $('#countdown').textContent = ''; return; }
  const left = diffDays(todayStr(), profile.goal_date);
  $('#countdown').textContent = left > 0 ? `${left} days to ${fmtDate(profile.goal_date)}` : left === 0 ? 'Today is the day 💍' : 'Goal date passed';
}

function renderSetup() {
  const p = profile;
  $('#s-name').value = p?.name ?? '';
  $('#s-start').value = p?.start_weight ?? '';
  $('#s-goal').value = p?.goal_weight ?? '';
  $('#s-height').value = p?.height_cm ?? '';
  $('#s-age').value = p?.age ?? '';
  $('#s-sex').value = p?.sex ?? 'm';
  $('#s-startdate').value = p?.start_date ?? todayStr();
  $('#s-goaldate').value = p?.goal_date ?? '2027-01-10';
  $('#setup-cancel').hidden = !p;
}

function setBar(el, frac, cls = '') {
  el.style.width = clamp(frac, 0, 1) * 100 + '%';
  el.className = cls;
}

function renderToday() {
  const p = profile, pl = plan(), st = status(), t = todayStr(), d = getDay(viewDate);

  $('#date-label').textContent = viewDate === t ? 'Today' : viewDate === addDays(t, -1) ? 'Yesterday' : fmtDate(viewDate, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#date-next').disabled = viewDate >= t;
  $('#date-prev').disabled = viewDate <= p.start_date;

  const lost = p.start_weight - pl.w, total = p.start_weight - p.goal_weight;
  $('#status-pill').textContent = st.label;
  $('#status-pill').className = 'pill ' + st.cls;
  $('#hero-days').textContent = `${pl.left} days left`;
  $('#lost').textContent = fmt1(Math.max(0, lost));
  $('#togo').textContent = fmt1(Math.max(0, pl.w - p.goal_weight));
  setBar($('#prog-bar'), total > 0 ? lost / total : 0, lost >= total ? 'done' : '');
  $('#prog-sub').textContent = weighIns().length
    ? `7-day avg ${fmt1(pl.w)} kg · target today ${fmt1(targetAt(t))} kg · goal ${fmt1(p.goal_weight)} kg`
    : `Start ${fmt1(p.start_weight)} kg → goal ${fmt1(p.goal_weight)} kg`;

  $('#w-input').value = d.weight ?? '';
  const prev = weighIns().filter((x) => x.date < viewDate).pop();
  if (d.weight && prev) {
    const diff = d.weight - prev.w;
    $('#w-delta').textContent = `${diff <= 0 ? '▼' : '▲'} ${fmt1(Math.abs(diff))} kg vs ${fmtDate(prev.date)}`;
  } else $('#w-delta').textContent = '';

  const eaten = kcalOf(viewDate);
  $('#kcal-total').textContent = `${fmtInt(eaten)} / ${fmtInt(pl.kcal)} kcal`;
  setBar($('#kcal-bar'), eaten / pl.kcal, eaten > pl.kcal ? 'over' : '');
  $('#food-list').innerHTML = d.foods.map((f, i) =>
    `<li><span>${esc(f.name)}<span class="mac">${macroText(f)}</span></span><span class="row gap"><span class="muted">${fmtInt(f.kcal)}</span><button class="x" data-i="${i}" aria-label="Remove">×</button></span></li>`).join('');
  $('#food-chips').innerHTML = recentFoods().map((f, i) =>
    `<button class="chip" data-i="${i}">${esc(f.name)} <b>${fmtInt(f.kcal)}</b></button>`).join('');

  const mt = macroTargets(pl), mm = macroTotals(viewDate);
  $('#macros').innerHTML = [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([k, label]) =>
    `<div class="macro ${k}"><div class="row between"><span class="strong">${label}</span><span>${Math.round(mm[k])} / ${mt[k]} g</span></div>
     <div class="bar"><div class="${k !== 'protein' && mm[k] > mt[k] ? 'over' : ''}" style="width:${clamp(mm[k] / mt[k], 0, 1) * 100}%"></div></div></div>`).join('');
  $('#macro-note').textContent = mm.missing ? `${mm.missing} item${mm.missing > 1 ? 's' : ''} without macros` : '';

  $('#photo-card').hidden = !CLOUD; // needs the Supabase Edge Function
  $('#food-hint').hidden = !CLOUD;
  updateFoodButton();
  $('#steps').value = d.steps ?? '';
  $('#active').value = d.active_cal ?? '';
  $('#steps-goal').textContent = `Goal ${fmtInt(pl.stepGoal)} steps`;
  setBar($('#steps-bar'), (d.steps || 0) / pl.stepGoal, (d.steps || 0) >= pl.stepGoal ? 'done' : '');

  const burnt = burnOf(viewDate);
  $('#act-total').textContent = burnt ? `~${fmtInt(burnt)} kcal burnt` : '';
  $('#act-list').innerHTML = d.activities.map((a, i) =>
    `<li><span>${activityOf(a.type).icon} ${esc(activityOf(a.type).label)} <span class="muted">· ${a.mins} min</span></span><span class="row gap"><span class="muted">~${fmtInt(a.kcal)}</span><button class="x" data-i="${i}" aria-label="Remove">×</button></span></li>`).join('');
  updateActPreview();

  $('#advice').innerHTML = advice().map((a) => `<li><span class="i">${a.icon}</span><span>${esc(a.t)}</span></li>`).join('');
}

let recentCache = [];
function recentFoods() {
  const seen = new Set(), out = [];
  for (const date of Object.keys(days).sort().reverse()) {
    for (const f of [...days[date].foods].reverse()) {
      const k = f.name.toLowerCase();
      if (seen.has(k) || f.name === 'Food') continue;
      seen.add(k); out.push(f);
      if (out.length >= 8) return (recentCache = out);
    }
  }
  return (recentCache = out);
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function renderProgress() {
  const p = profile, pl = plan(), t = todayStr();
  const labels = [];
  for (let d = p.start_date; d <= p.goal_date; d = addDays(d, 1)) labels.push(d);

  const accent = cssVar('--accent'), muted = cssVar('--muted'), line = cssVar('--line'), good = cssVar('--good');
  let datasets, note;
  if (chartMode === 'weight') {
    datasets = [
      { type: 'line', label: 'Weight', data: labels.map((d) => getDay(d).weight), borderColor: accent, backgroundColor: accent, pointRadius: 3, borderWidth: 2.5, spanGaps: true, tension: 0.25 },
      { type: 'line', label: 'Target', data: labels.map((d) => +targetAt(d).toFixed(2)), borderColor: muted, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0 },
    ];
    note = 'Solid line is your weigh-ins. Dashed line is the path to your goal. Stay on or under it.';
  } else if (chartMode === 'kcal') {
    datasets = [
      { type: 'bar', label: 'Calories', data: labels.map((d) => kcalOf(d) || null), backgroundColor: labels.map((d) => (kcalOf(d) > pl.kcal ? cssVar('--bad') : accent)), borderRadius: 4 },
      { type: 'line', label: 'Target', data: labels.map(() => pl.kcal), borderColor: muted, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0 },
    ];
    note = `Daily target ${fmtInt(pl.kcal)} kcal. Red bars are over-target days.`;
  } else {
    datasets = [
      { type: 'bar', label: 'Steps', data: labels.map((d) => getDay(d).steps), backgroundColor: labels.map((d) => ((getDay(d).steps || 0) >= pl.stepGoal ? good : accent)), borderRadius: 4 },
      { type: 'line', label: 'Goal', data: labels.map(() => pl.stepGoal), borderColor: muted, borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0 },
    ];
    note = `Daily goal ${fmtInt(pl.stepGoal)} steps. Green bars hit the goal.`;
  }
  $('#chart-note').textContent = note;

  if (chart) chart.destroy();
  if (window.Chart) {
    chart = new Chart($('#chart'), {
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: (it) => fmtDate(labels[it[0].dataIndex], { weekday: 'short', day: 'numeric', month: 'short' }) } },
        },
        scales: {
          x: { grid: { display: false }, border: { color: line }, ticks: { color: muted, maxTicksLimit: 6, maxRotation: 0, callback: (v) => fmtDate(labels[v]) } },
          y: { grid: { color: line }, border: { display: false }, ticks: { color: muted }, beginAtZero: chartMode !== 'weight' },
        },
      },
    });
  }

  const tr = trend();
  const logged = Object.keys(days).sort().filter((d) => kcalOf(d) > 0 && d < t);
  const avgKcal = logged.length ? avg(logged.slice(-7).map(kcalOf)) : null;
  const stepDays = Object.keys(days).sort().filter((d) => getDay(d).steps != null && d <= t);
  const avgSteps = stepDays.length ? avg(stepDays.slice(-7).map((d) => getDay(d).steps)) : null;
  $('#stats').innerHTML = [
    ['Lost so far', `${fmt1(p.start_weight - pl.w)} kg`],
    ['Needed pace', `${fmt1(pl.toLose / (pl.left / 7))} kg/wk`],
    ['Your pace (14d)', tr ? `${fmt1(-tr.perWeek)} kg/wk` : 'Need 5+ weigh-ins'],
    [`Projected ${fmtDate(p.goal_date)}`, tr ? `${fmt1(tr.atGoal)} kg` : '–'],
    ['Avg calories (7d)', avgKcal ? fmtInt(avgKcal) : '–'],
    ['Avg steps (7d)', avgSteps != null ? fmtInt(avgSteps) : '–'],
  ].map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  const rows = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(t, -i);
    if (d < p.start_date) break;
    const x = getDay(d), k = kcalOf(d);
    rows.push(`<tr data-date="${d}"><td>${fmtDate(d, { weekday: 'short', day: 'numeric' })}</td><td>${x.weight ? fmt1(x.weight) : '–'}</td><td>${k ? fmtInt(k) : '–'}</td><td>${x.steps != null ? fmtInt(x.steps) : '–'}</td></tr>`);
  }
  $('#hist').innerHTML = rows.join('');
}

function renderPlan() {
  const p = profile, pl = plan();
  $('#targets').innerHTML = [
    ['Calories / day', fmtInt(pl.kcal)],
    ['Protein / day', `${pl.protein} g`],
    ['Carbs / day', `${macroTargets(pl).carbs} g`],
    ['Fat / day', `${macroTargets(pl).fat} g`],
    ['Steps / day', fmtInt(pl.stepGoal)],
    ['Expected loss', `${fmt1(pl.weekly)} kg/wk`],
  ].map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');

  let note;
  if (pl.toLose <= 0) {
    note = '🎉 You have hit your goal weight. Your calories are set to maintenance. Keep training and stay steady.';
  } else {
    note = `To lose ${fmt1(pl.toLose)} kg in ${pl.left} days you need a deficit of about ${fmtInt(pl.needed)} kcal/day (your maintenance is ~${fmtInt(pl.tdee)}). `;
    if (pl.extraSteps > 0) {
      note += `Calories are capped at a safe ${fmtInt(pl.kcal)} kcal, so the rest comes from walking. That's why your step goal is ${fmtInt(pl.stepGoal)}. `;
    }
    if (pl.projected > p.goal_weight + 0.3) {
      const per1k = (1000 * pl.kcalPerStep * pl.left) / KCAL_PER_KG;
      note += `Sticking to this plan puts you around ${fmt1(pl.projected)} kg by ${fmtDate(p.goal_date)}, which is still a big result. Every extra 1,000 steps a day adds ~${fmt1(per1k)} kg.`;
    } else {
      note += `Stick to these numbers and you'll reach ${fmt1(p.goal_weight)} kg by ${fmtDate(p.goal_date)}.`;
    }
  }
  $('#plan-note').textContent = note;

  const dow = new Date().getDay();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const wk = workouts();
  $('#week').innerHTML = order.map((i) => `<li class="${i === dow ? 'today' : ''}"><span class="d">${wk[i].d}</span><span class="w">${esc(wk[i].t)}</span></li>`).join('');
  $('#week-note').textContent = 'Strength: pick a weight you can lift for the listed reps with 1–2 reps left in the tank. Add a little weight each week. '
    + (isF() ? "Lifting won't make you bulky. It keeps your muscle so the weight you lose is fat, which gives a toned, defined look in photos."
             : 'Lifting keeps your muscle, so the weight you lose is fat.');
  renderAiPlan();
  $('#rules').innerHTML = (isF() ? [...FOOD_RULES, ...FOOD_RULES_F] : FOOD_RULES).map((a) => `<li><span class="i">${a.icon}</span><span>${esc(a.t)}</span></li>`).join('');

  const base = location.origin + location.pathname;
  $('#shortcut-url').textContent = `${base}?steps=[steps]&active=[active]&weight=[weight]`;
  $('#signout').hidden = !CLOUD;
  $('#mode-note').textContent = CLOUD ? `Signed in as ${user?.email || ''}. Data syncs across devices.` : 'Local mode: data is saved in this browser only. Add your Supabase keys in config.js to sync.';
}

function renderAiPlan() {
  const ai = profile.plan;
  const card = $('#ai-plan');
  card.hidden = !CLOUD && !ai;
  if (!ai) {
    card.innerHTML = `<h2>✨ Personalise your plan</h2>
      <p class="small">Answer a few quick questions and Claude builds your workouts, meals and tips around you: your schedule, what you enjoy, how you eat and what usually gets in the way.</p>
      <div class="stack" style="margin-top:12px"><button class="btn primary" data-act="quiz">Start the questionnaire</button></div>`;
    $('#ai-meals').hidden = true;
    return;
  }
  card.innerHTML = `<h2>✨ Your plan</h2>
    <p class="plan-summary">${esc(ai.summary)}</p>
    <ul class="advice">${ai.tips.map((t) => `<li><span class="i">✨</span><span>${esc(t)}</span></li>`).join('')}</ul>
    <p class="muted small">Built ${ai.created ? fmtDate(ai.created) : ''} from your answers. Your weekly workouts below follow this plan.</p>
    <div class="stack" style="margin-top:10px"><button class="btn" data-act="quiz">Redo questionnaire</button></div>`;

  $('#ai-meals').hidden = !ai.meals?.length;
  $('#meal-ideas').innerHTML = ['breakfast', 'lunch', 'dinner', 'snack'].map((type) => {
    const list = (ai.meals || []).map((m, i) => ({ ...m, i })).filter((m) => m.meal === type);
    if (!list.length) return '';
    return `<div class="meal-group"><h3>${type === 'snack' ? 'Snacks' : type}</h3><ul class="list">${list.map((m) =>
      `<li><span>${esc(m.name)}<span class="mac">${fmtInt(m.kcal)} kcal · P ${Math.round(m.protein_g)} · C ${Math.round(m.carbs_g)} · F ${Math.round(m.fat_g)} g</span></span><button class="add" data-meal="${m.i}" aria-label="Add to today">+</button></li>`).join('')}</ul></div>`;
  }).join('');
}

$('#ai-plan').addEventListener('click', (e) => { if (e.target.closest('[data-act="quiz"]')) show('quiz'); });
$('#meal-ideas').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-meal]');
  if (!b) return;
  const m = profile.plan.meals[+b.dataset.meal];
  const t = todayStr();
  ensureDay(t).foods.push(foodItem({ name: m.name, kcal: m.kcal, protein: m.protein_g, carbs: m.carbs_g, fat: m.fat_g }));
  toast(`Added ${m.name} to today`);
  await saveDay(t);
});

// ---------- questionnaire ----------
function quizQuestions() {
  const outfit = isF() ? 'dress' : 'suit';
  return [
    { id: 'focus', q: 'What matters most to you?', multi: true, opts: ['Lose weight', 'Tone up', `Arms & shoulders (for the ${outfit})`, 'Glutes & legs', 'Flatter stomach', 'More energy', 'Feel confident in photos'] },
    { id: 'experience', q: 'How experienced are you with exercise?', opts: ['Beginner', 'Some experience', 'Very experienced'] },
    { id: 'days', q: 'How many days a week can you train?', opts: ['2', '3', '4', '5', '6'] },
    { id: 'minutes', q: 'How long can each session be?', opts: ['20 min', '30 min', '45 min', '60 min+'] },
    { id: 'where', q: 'Where will you train?', multi: true, opts: ['Gym', 'Home (some equipment)', 'Home (no equipment)', 'Outdoors', 'Classes / studio'] },
    { id: 'enjoy', q: 'What do you enjoy (or want to try)?', multi: true, opts: ['Walking', 'Running', 'Weights', 'Pilates', 'Yoga', 'Tennis', 'Dance', 'Swimming', 'Cycling', 'HIIT / classes', 'Hiking'] },
    { id: 'avoid', q: 'Any injuries or things to avoid?', text: true, ph: 'e.g. sore knees, no jumping' },
    { id: 'diet', q: 'How do you eat?', multi: true, opts: ['No restrictions', 'Vegetarian', 'Vegan', 'Pescatarian', 'Gluten-free', 'Dairy-free', 'Halal'] },
    { id: 'cooking', q: 'How much do you like to cook?', opts: ['Love cooking', 'Simple meals', 'As little as possible'] },
    { id: 'challenges', q: 'What usually gets in the way?', multi: true, opts: ['Snacking / sweet tooth', 'Alcohol & social events', 'Eating out / takeaway', 'Late-night eating', 'Busy, no time', 'Stress eating', 'Skipping meals then overeating', 'Motivation'] },
    { id: 'foods', q: 'Foods you love or can\'t stand?', text: true, ph: 'e.g. love Mexican and sushi, hate mushrooms' },
    { id: 'notes', q: 'Anything else Claude should know?', text: true, ph: 'e.g. shift work, final fitting on 20 Dec' },
  ];
}

function renderQuiz() {
  const a = profile?.answers || {};
  $('#quiz-msg').textContent = '';
  $('#quiz-go').disabled = false;
  $('#quiz').innerHTML = quizQuestions().map((q) => {
    if (q.text) return `<div><div class="q-title">${esc(q.q)} <span class="muted small">(optional)</span></div><textarea data-q="${q.id}" maxlength="300" placeholder="${esc(q.ph)}">${esc(a[q.id] || '')}</textarea></div>`;
    const picked = [].concat(a[q.id] || []);
    return `<div><div class="q-title">${esc(q.q)}</div><div class="chips" data-q="${q.id}" ${q.multi ? 'data-multi' : ''}>${q.opts.map((o) =>
      `<button type="button" class="chip${picked.includes(o) ? ' on' : ''}" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`;
  }).join('');
}

$('#quiz').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const group = chip.parentElement;
  if (!group.hasAttribute('data-multi')) group.querySelectorAll('.chip').forEach((c) => c !== chip && c.classList.remove('on'));
  chip.classList.toggle('on');
});

function quizAnswers() {
  const out = {};
  for (const q of quizQuestions()) {
    if (q.text) { out[q.id] = $(`#quiz textarea[data-q="${q.id}"]`).value.trim(); continue; }
    const on = [...document.querySelectorAll(`#quiz [data-q="${q.id}"] .chip.on`)].map((c) => c.dataset.v);
    out[q.id] = q.multi ? on : on[0] || '';
  }
  return out;
}

$('#quiz-skip').addEventListener('click', () => { viewDate = todayStr(); show('today'); });
$('#quiz-go').addEventListener('click', async () => {
  const answers = quizAnswers();
  if (!answers.days || !answers.experience) { $('#quiz-msg').textContent = 'Pick your experience and how many days you can train, at least.'; return; }
  const pl = plan(), mt = macroTargets(pl), p = profile;
  const summary = {
    name: p.name || null, sex: p.sex === 'f' ? 'female' : 'male', age: p.age, height_cm: p.height_cm,
    current_weight_kg: +fmt1(pl.w), goal_weight_kg: p.goal_weight, goal_date: p.goal_date, days_left: pl.left,
    daily_targets: { kcal: pl.kcal, protein_g: pl.protein, carbs_g: mt.carbs, fat_g: mt.fat, steps: pl.stepGoal },
  };
  $('#quiz-go').disabled = true;
  $('#quiz-msg').textContent = '✨ Claude is building your plan. This takes about 30–60 seconds…';
  try {
    const { data, error } = await sb.functions.invoke('food-photo', { body: { mode: 'plan', answers, profile: summary } });
    if (error) throw new Error(await fnError(error));
    if (!data?.week?.length) throw new Error('No plan came back. Try again.');
    profile = { ...profile, answers, plan: { ...data, created: todayStr() } };
    await saveProfile();
    toast('Your plan is ready');
    show('plan');
  } catch (err) {
    $('#quiz-go').disabled = false;
    $('#quiz-msg').textContent = err.message || 'Something went wrong. Try again.';
  }
});

// ---------- Apple Health (via iOS Shortcut URL params) ----------
function readHealthParams() {
  const q = new URLSearchParams(location.search);
  if (!['steps', 'active', 'weight'].some((k) => q.has(k))) return null;
  const parse = (v, decimal) => {
    if (v == null || v === '') return null;
    const s = decimal ? String(v).replace(',', '.') : String(v).replace(/,/g, '');
    const m = s.match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : todayStr();
  history.replaceState(null, '', location.pathname);
  return { date, steps: parse(q.get('steps')), active: parse(q.get('active')), weight: parse(q.get('weight'), true) };
}

async function applyHealth() {
  if (!pendingHealth) return;
  const h = pendingHealth;
  pendingHealth = null;
  sessionStorage.removeItem('xf-health');
  const d = ensureDay(h.date), bits = [];
  if (h.steps != null) { d.steps = Math.round(h.steps); bits.push(`${fmtInt(d.steps)} steps`); }
  if (h.active != null) { d.active_cal = Math.round(h.active); bits.push(`${fmtInt(d.active_cal)} active kcal`); }
  // Skip readings far from your recent average (e.g. someone else used the scale)
  if (h.weight && Math.abs(h.weight - currentWeight(h.date)) <= 3 && !d.weight) { d.weight = Math.round(h.weight * 10) / 10; bits.push(`${fmt1(d.weight)} kg`); }
  await saveDay(h.date);
  if (bits.length) toast('Synced from Apple Health: ' + bits.join(', '));
}

// ---------- events ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'today') viewDate = todayStr();
  show(b.dataset.view);
}));

$('#date-prev').addEventListener('click', () => { viewDate = addDays(viewDate, -1); renderToday(); });
$('#date-next').addEventListener('click', () => { if (viewDate < todayStr()) { viewDate = addDays(viewDate, 1); renderToday(); } });

$('#w-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = numOrNull($('#w-input').value);
  if (v != null && (v < 30 || v > 300)) return toast('That weight looks off. Check it and try again.');
  ensureDay(viewDate).weight = v;
  $('#w-input').blur();
  renderToday();
  await saveDay(viewDate);
  if (v) toast('Weight saved');
});

async function addFood(item) {
  ensureDay(viewDate).foods.push(foodItem(item));
  renderToday();
  await saveDay(viewDate);
}

$('#food-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kcal = Math.round(numOrNull($('#food-kcal').value) || 0);
  const desc = $('#food-name').value.trim();
  // No calories typed: let Claude estimate from the description
  if (!$('#food-kcal').value.trim() && desc && CLOUD) return estimateFood(desc);
  if (kcal <= 0 || kcal > 5000) return toast(CLOUD ? 'Type what you ate, or the calories' : 'Enter the calories (e.g. 450)');
  $('#food-name').value = ''; $('#food-kcal').value = '';
  $('#food-kcal').blur();
  await addFood({ name: desc.slice(0, 60), kcal });
});

async function estimateFood(desc) {
  const panel = $('#est-panel');
  if (desc.length > 500) return toast('Keep it under 500 characters');
  $('#food-name').blur();
  renderReview(panel, { loading: 'Working out the calories…' });
  try {
    const { data, error } = await sb.functions.invoke('food-photo', { body: { text: desc } });
    if (error) throw new Error(await fnError(error));
    const items = reviewItems(data);
    if (!items.length) return renderReview(panel, { error: data.summary || "Couldn't work that one out. Try adding more detail." });
    $('#food-name').value = '';
    updateFoodButton();
    renderReview(panel, { summary: data.summary, items });
  } catch (err) {
    renderReview(panel, { error: err.message || 'Something went wrong.' });
  }
}
function updateFoodButton() {
  const estimate = CLOUD && !$('#food-kcal').value.trim() && $('#food-name').value.trim();
  $('#food-submit').textContent = estimate ? '✨ Estimate' : 'Add';
}
$('#food-name').addEventListener('input', updateFoodButton);
$('#food-kcal').addEventListener('input', updateFoodButton);

// ---------- workouts ----------
$('#act-type').innerHTML = ACTIVITIES.map((a) => `<option value="${a.key}">${a.icon} ${a.label}</option>`).join('');

function updateActPreview() {
  const mins = numOrNull($('#act-mins').value);
  $('#act-preview').textContent = mins > 0 && mins <= 600
    ? `≈ ${fmtInt(burnFor($('#act-type').value, mins, currentWeight()))} kcal burnt (estimate for your weight)`
    : 'Calories burnt are on top of your normal day. They are not added to your food budget, which keeps you on pace for the goal.';
}
$('#act-type').addEventListener('change', updateActPreview);
$('#act-mins').addEventListener('input', updateActPreview);

$('#act-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mins = Math.round(numOrNull($('#act-mins').value) || 0);
  if (mins <= 0 || mins > 600) return toast('Enter how many minutes (e.g. 45)');
  const type = $('#act-type').value;
  const kcal = burnFor(type, mins, currentWeight());
  ensureDay(viewDate).activities.push({ type, mins, kcal });
  $('#act-mins').value = '';
  $('#act-mins').blur();
  renderToday();
  toast(`${activityOf(type).label}: ~${fmtInt(kcal)} kcal`);
  await saveDay(viewDate); // after the toast so a save warning isn't hidden by it
});

$('#act-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.x');
  if (!b) return;
  ensureDay(viewDate).activities.splice(+b.dataset.i, 1);
  renderToday();
  await saveDay(viewDate);
});

// ---------- photo → calories (Claude via the food-photo Edge Function) ----------

// Shrinks the photo on the phone (also turns iPhone HEIC into JPEG) before upload
function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = () => reject(new Error("Couldn't read that image."));
    img.src = URL.createObjectURL(file);
  });
}

async function lookupBarcode(code) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_size,serving_quantity,product_quantity`);
    const j = await r.json();
    if (j.status !== 1) return null;
    const p = j.product, n = p.nutriments || {};
    const per100 = n['energy-kcal_100g'] ?? (n.energy_100g ? n.energy_100g / 4.184 : null); // energy_100g is kJ
    const brand = p.brands?.split(',')[0]?.trim(), title = p.product_name?.trim() || '';
    const name = ((brand && !title.toLowerCase().includes(brand.toLowerCase()) ? brand + ' ' : '') + title).trim().slice(0, 40) || 'Product';
    const m100 = { protein: n.proteins_100g, carbs: n.carbohydrates_100g, fat: n.fat_100g };
    const has100 = MACROS.every((m) => m100[m] != null);
    const mk = (label, grams) => {
      const it = { name: `${name} (${label})`, kcal: (per100 * grams) / 100 };
      if (has100) for (const m of MACROS) it[m] = (m100[m] * grams) / 100;
      return it;
    };
    const items = [];
    if (per100 && +p.serving_quantity) items.push(mk(`1 serve, ${p.serving_size || p.serving_quantity + ' g'}`, +p.serving_quantity));
    else if (n['energy-kcal_serving']) {
      const it = { name: `${name} (1 serve${p.serving_size ? ', ' + p.serving_size : ''})`, kcal: n['energy-kcal_serving'] };
      if (n.proteins_serving != null) Object.assign(it, { protein: n.proteins_serving, carbs: n.carbohydrates_serving ?? 0, fat: n.fat_serving ?? 0 });
      items.push(it);
    }
    if (per100 && +p.product_quantity) items.push(mk('whole pack', +p.product_quantity));
    if (per100) items.push(mk('100 g', 100));
    return items.length ? { name, items } : null;
  } catch { return null; }
}

async function fnError(error) {
  if (error.context?.status === 404) return 'Calorie estimates aren\'t set up yet. Deploy the food-photo function (see README).';
  try { const j = await error.context.json(); if (j?.error) return j.error; } catch {}
  return 'Could not reach the photo service. Check your connection.';
}

// Review list shared by the photo card and the typed-food estimate (items kept on the element)
function renderReview(el, state) {
  el.hidden = false;
  if (state.loading) { el.innerHTML = `<p class="small muted">🔍 ${esc(state.loading)}</p>`; return; }
  if (state.error) { el.innerHTML = `<p class="small">${esc(state.error)}</p><div class="row gap"><button class="btn" data-act="close">Close</button></div>`; return; }
  el.items = state.items;
  el.innerHTML = `<p class="small muted">${esc(state.summary || '')}</p>
    <ul class="list">${state.items.map((it, i) => `<li><label class="pick"><input type="checkbox" data-i="${i}" ${it.on ? 'checked' : ''}><span>${esc(it.name)}<span class="mac">${macroText(it)}</span></span></label><input class="kcal-in" type="number" min="1" max="5000" inputmode="numeric" data-k="${i}" value="${Math.round(it.kcal)}"></li>`).join('')}</ul>
    <p class="small muted">Tick what you ate and adjust calories if needed.</p>
    <div class="row gap"><button class="btn primary" data-act="add">Add</button><button class="btn" data-act="close">Cancel</button></div>`;
}

// Meals: tick every item. Labels/barcodes are alternatives (serve vs pack): tick the first
const reviewItems = (data) => (data.items || []).map((it, i) => ({
  name: it.name, kcal: it.kcal, on: data.kind === 'meal' || i === 0,
  ...(it.protein_g != null ? { protein: it.protein_g, carbs: it.carbs_g, fat: it.fat_g } : {}),
}));

$('#photo-btn').addEventListener('click', () => $('#photo-input').click());
$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const panel = $('#photo-panel');
  const renderPhotoPanel = (state) => renderReview(panel, state);
  renderPhotoPanel({ loading: 'Reading your photo…' });
  try {
    const image = await resizeImage(file);
    renderPhotoPanel({ loading: 'Working out the calories…' });
    const { data, error } = await sb.functions.invoke('food-photo', { body: { image, mediaType: 'image/jpeg' } });
    if (error) throw new Error(await fnError(error));
    let items = reviewItems(data);
    let summary = data.summary;
    if (data.kind === 'barcode' && data.barcode) {
      renderPhotoPanel({ loading: `Looking up barcode ${data.barcode}…` });
      const found = await lookupBarcode(data.barcode);
      if (found) { items = found.items.map((it, i) => ({ ...it, on: i === 0 })); summary = `Found ${found.name} (Open Food Facts).`; }
      else if (!items.length) return renderPhotoPanel({ error: `Couldn't find barcode ${data.barcode}. Snap the nutrition label instead.` });
    }
    if (!items.length) return renderPhotoPanel({ error: summary || "Couldn't spot any food in that photo." });
    renderPhotoPanel({ summary, items });
  } catch (err) {
    renderPhotoPanel({ error: err.message || 'Something went wrong.' });
  }
});

for (const panel of [$('#photo-panel'), $('#est-panel')]) {
  panel.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { panel.hidden = true; return; }
    if (act !== 'add') return;
    const d = ensureDay(viewDate);
    let n = 0;
    panel.querySelectorAll('[data-i]').forEach((cb) => {
      if (!cb.checked) return;
      const kcal = Math.round(numOrNull(panel.querySelector(`[data-k="${cb.dataset.i}"]`).value) || 0);
      if (kcal > 0 && kcal <= 5000) { d.foods.push(foodItem(panel.items[+cb.dataset.i], kcal)); n++; }
    });
    if (!n) return toast('Tick at least one item');
    panel.hidden = true;
    renderToday();
    await saveDay(viewDate);
    toast(`Added ${n} item${n > 1 ? 's' : ''}`);
  });
}

$('#food-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) addFood(recentCache[+b.dataset.i]);
});
$('#food-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.x');
  if (!b) return;
  ensureDay(viewDate).foods.splice(+b.dataset.i, 1);
  renderToday();
  await saveDay(viewDate);
});

for (const [id, key] of [['#steps', 'steps'], ['#active', 'active_cal']]) {
  $(id).addEventListener('change', async () => {
    const v = numOrNull($(id).value);
    ensureDay(viewDate)[key] = v == null ? null : Math.round(v);
    renderToday();
    await saveDay(viewDate);
  });
}

$('#chart-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  chartMode = b.dataset.mode;
  document.querySelectorAll('#chart-seg button').forEach((x) => x.classList.toggle('on', x === b));
  renderProgress();
});
$('#hist').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-date]');
  if (tr) { viewDate = tr.dataset.date; show('today'); }
});

$('#s-start').addEventListener('input', () => {
  const s = numOrNull($('#s-start').value);
  if (s && !profile) $('#s-goal').value = fmt1(s - 10);
});
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {
    name: $('#s-name').value.trim().slice(0, 30) || null,
    start_weight: +$('#s-start').value, goal_weight: +$('#s-goal').value,
    height_cm: +$('#s-height').value, age: +$('#s-age').value, sex: $('#s-sex').value,
    start_date: $('#s-startdate').value, goal_date: $('#s-goaldate').value,
  };
  if (next.goal_weight >= next.start_weight) return toast('Goal weight should be below your starting weight');
  if (next.goal_date <= next.start_date) return toast('Goal date must be after the start date');
  const first = !profile;
  profile = { ...profile, ...next }; // keeps the questionnaire answers and plan
  try { await saveProfile(); } catch (err) { return toast("Couldn't save: " + err.message); }
  // First time: log the starting weight on the start date so the graph begins there
  if (first && !getDay(next.start_date).weight) { ensureDay(next.start_date).weight = next.start_weight; await saveDay(next.start_date); }
  viewDate = todayStr();
  show(first && CLOUD ? 'quiz' : 'today');
});
$('#setup-cancel').addEventListener('click', () => show('plan'));
$('#edit-goal').addEventListener('click', () => show('setup'));

$('#export').addEventListener('click', () => {
  const rows = [['date', 'weight_kg', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'steps', 'active_kcal', 'workout_kcal', 'workouts', 'foods']];
  for (const d of Object.keys(days).sort()) {
    const x = days[d];
    const mm = macroTotals(d);
    rows.push([d, x.weight ?? '', kcalOf(d) || '', mm.protein || '', mm.carbs || '', mm.fat || '', x.steps ?? '', x.active_cal ?? '', burnOf(d) || '',
      (x.activities || []).map((a) => `${activityOf(a.type).label} ${a.mins} min`).join('; '), x.foods.map((f) => `${f.name} (${f.kcal})`).join('; ')]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `x-fitness-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- appearance (per device; Auto follows the phone's setting) ----------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('#theme-seg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === (theme || 'auto')));
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    const forced = theme === 'light' ? '#f5f6f8' : theme === 'dark' ? '#0e1013' : null;
    m.content = forced || (m.media.includes('dark') ? '#0e1013' : '#f5f6f8');
  });
}
let savedTheme = 'auto';
try { savedTheme = localStorage.getItem('xf-theme') || 'auto'; } catch {}
applyTheme(savedTheme);
$('#theme-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try { localStorage.setItem('xf-theme', b.dataset.theme); } catch {}
  applyTheme(b.dataset.theme);
  if (currentView === 'progress') renderProgress(); // chart colours are read from CSS when drawn
});

$('#signout').addEventListener('click', async () => { if (CLOUD) await sb.auth.signOut(); });

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-msg').textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email: $('#auth-email').value.trim(), password: $('#auth-pass').value });
  $('#auth-msg').textContent = error ? error.message : '';
});
$('#auth-signup').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim(), password = $('#auth-pass').value;
  if (!email || password.length < 6) { $('#auth-msg').textContent = 'Enter an email and a password of at least 6 characters.'; return; }
  $('#auth-msg').textContent = 'Creating account…';
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) $('#auth-msg').textContent = error.message;
  else if (!data.session) $('#auth-msg').textContent = 'Check your email to confirm your account, then sign in here.';
});

// Refresh when you come back to the app (e.g. after the Shortcut synced from Safari)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !profile || (CLOUD && !user)) return;
  try { ({ days } = await loadAll()); } catch { return; }
  if (viewDate > todayStr()) viewDate = todayStr();
  if (['today', 'progress', 'plan'].includes(currentView) && !document.activeElement?.matches('input')) rerender();
});

// ---------- boot ----------
async function boot() {
  if (CLOUD && !user) { profile = null; days = {}; return show('auth'); }
  try { ({ profile, days } = await loadAll()); }
  catch (err) { toast('Could not load data: ' + err.message); return; }
  if (!profile) return show('setup');
  await applyHealth();
  viewDate = todayStr();
  show('today');
}

async function init() {
  pendingHealth = readHealthParams();
  if (pendingHealth) sessionStorage.setItem('xf-health', JSON.stringify(pendingHealth));
  else { try { pendingHealth = JSON.parse(sessionStorage.getItem('xf-health')); } catch {} }

  if (CLOUD) {
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    sb.auth.onAuthStateChange((_event, session) => {
      const was = user?.id;
      user = session?.user || null;
      // Deferred: supabase-js deadlocks if you query inside this callback
      if (user?.id !== was) setTimeout(boot, 0);
    });
  }
  boot();
}

init();
})();
