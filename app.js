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
    sb.from('days').select('date,weight,steps,active_cal,foods').order('date'),
  ]);
  if (p.error) throw p.error;
  if (d.error) throw d.error;
  const map = {};
  for (const r of d.data) map[r.date] = { weight: numOrNull(r.weight), steps: r.steps, active_cal: r.active_cal, foods: r.foods || [] };
  let prof = null;
  if (p.data) {
    const { user_id, ...rest } = p.data;
    prof = { ...rest, start_weight: +rest.start_weight, goal_weight: +rest.goal_weight, height_cm: +rest.height_cm, age: +rest.age };
  }
  return { profile: prof, days: map };
}

async function saveProfile() {
  if (!CLOUD) return localWrite();
  const { error } = await sb.from('profile').upsert({ user_id: user.id, ...profile });
  if (error) throw error;
}

async function saveDay(date) {
  if (!CLOUD) return localWrite();
  const d = days[date];
  const { error } = await sb.from('days').upsert({
    user_id: user.id, date, weight: d.weight, steps: d.steps, active_cal: d.active_cal,
    foods: d.foods, updated_at: new Date().toISOString(),
  });
  if (error) toast("Couldn't save. Check your connection.");
}

const getDay = (date) => days[date] || { weight: null, steps: null, active_cal: null, foods: [] };
const ensureDay = (date) => (days[date] ||= { weight: null, steps: null, active_cal: null, foods: [] });
const kcalOf = (date) => getDay(date).foods.reduce((s, f) => s + (+f.kcal || 0), 0);

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
  const protein = Math.round((p.goal_weight * 1.8) / 5) * 5;
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
const WORKOUTS = [
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

function advice() {
  const t = todayStr(), pl = plan(), st = status(), out = [];
  const today = getDay(t), yest = getDay(addDays(t, -1));
  const eaten = kcalOf(t), yKcal = kcalOf(addDays(t, -1));

  if (pl.left <= 7) out.push({ icon: '💍', t: `Final week. Keep calories steady, go easy on salt and alcohol, drink plenty of water and sleep well. Don't crash diet now.` });

  if (!today.weight) out.push({ icon: '⚖️', t: 'Weigh in this morning, after the toilet and before you eat or drink.' });
  else if (yest.weight && today.weight - yest.weight >= 0.5) out.push({ icon: '🧂', t: `Up ${fmt1(today.weight - yest.weight)} kg overnight. That's almost always water and salt, not fat. Trust the 7-day average.` });

  if (yKcal > pl.kcal + 250) out.push({ icon: '↩️', t: `Yesterday was ${fmtInt(yKcal - pl.kcal)} kcal over. Don't skip meals to make up for it. Just hit today's target and add a 30 min walk.` });

  if (eaten === 0) out.push({ icon: '🍳', t: `Target today: ${fmtInt(pl.kcal)} kcal and ${pl.protein} g protein. Start with a protein breakfast, e.g. 3 eggs + toast, or Greek yoghurt + berries.` });
  else if (eaten <= pl.kcal) out.push({ icon: '🍽️', t: `${fmtInt(pl.kcal - eaten)} kcal left today. Make the next meal lean protein + veg.` });
  else out.push({ icon: '🛑', t: `${fmtInt(eaten - pl.kcal)} kcal over today. Kitchen's closed. Herbal tea, water, or a walk if you're hungry.` });

  if (today.steps == null) out.push({ icon: '👟', t: `Step goal: ${fmtInt(pl.stepGoal)}. Run the "Sync X-Fitness" Shortcut to pull steps from Apple Health.` });
  else if (today.steps < pl.stepGoal) {
    const mins = Math.ceil((pl.stepGoal - today.steps) / 110 / 5) * 5;
    out.push({ icon: '👟', t: `${fmtInt(pl.stepGoal - today.steps)} steps to go. That's about a ${mins} min walk.` });
  } else out.push({ icon: '✅', t: `Step goal smashed: ${fmtInt(today.steps)} steps.` });

  const w = WORKOUTS[new Date().getDay()];
  out.push({ icon: w.icon, t: `Today's workout: ${w.t}` });

  if (st.cls === 'warn' || st.cls === 'bad') out.push({ icon: '🎯', t: 'Behind the line. This week: zero alcohol, no liquid calories, and log every bite. That alone usually closes the gap.' });
  else if (st.d != null && st.d <= -0.3) out.push({ icon: '🙌', t: "Ahead of schedule. Keep calories where they are and don't eat back your progress." });

  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  out.push(FOOD_RULES[dayOfYear % FOOD_RULES.length]);
  return out;
}

// ---------- views ----------
function show(view) {
  currentView = view;
  for (const v of ['auth', 'setup', 'today', 'progress', 'plan']) $('#view-' + v).hidden = v !== view;
  const main = ['today', 'progress', 'plan'].includes(view);
  $('#tabs').hidden = !main;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  renderHeader();
  if (view === 'setup') renderSetup();
  if (view === 'today') renderToday();
  if (view === 'progress') renderProgress();
  if (view === 'plan') renderPlan();
  window.scrollTo(0, 0);
}

function rerender() { if (currentView) show(currentView); }

function renderHeader() {
  if (!profile) { $('#countdown').textContent = ''; return; }
  const left = diffDays(todayStr(), profile.goal_date);
  $('#countdown').textContent = left > 0 ? `${left} days to ${fmtDate(profile.goal_date)}` : left === 0 ? 'Today is the day 💍' : 'Goal date passed';
}

function renderSetup() {
  const p = profile;
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
    `<li><span>${esc(f.name)}</span><span class="row gap"><span class="muted">${fmtInt(f.kcal)}</span><button class="x" data-i="${i}" aria-label="Remove">×</button></span></li>`).join('');
  $('#food-chips').innerHTML = recentFoods().map((f, i) =>
    `<button class="chip" data-i="${i}">${esc(f.name)} <b>${fmtInt(f.kcal)}</b></button>`).join('');

  $('#steps').value = d.steps ?? '';
  $('#active').value = d.active_cal ?? '';
  $('#steps-goal').textContent = `Goal ${fmtInt(pl.stepGoal)} steps`;
  setBar($('#steps-bar'), (d.steps || 0) / pl.stepGoal, (d.steps || 0) >= pl.stepGoal ? 'done' : '');

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
  $('#week').innerHTML = order.map((i) => `<li class="${i === dow ? 'today' : ''}"><span class="d">${WORKOUTS[i].d}</span><span class="w">${esc(WORKOUTS[i].t)}</span></li>`).join('');
  $('#rules').innerHTML = FOOD_RULES.map((a) => `<li><span class="i">${a.icon}</span><span>${esc(a.t)}</span></li>`).join('');

  const base = location.origin + location.pathname;
  $('#shortcut-url').textContent = `${base}?steps=[steps]&active=[active]&weight=[weight]`;
  $('#signout').hidden = !CLOUD;
  $('#mode-note').textContent = CLOUD ? `Signed in as ${user?.email || ''}. Data syncs across devices.` : 'Local mode: data is saved in this browser only. Add your Supabase keys in config.js to sync.';
}

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

async function addFood(name, kcal) {
  ensureDay(viewDate).foods.push({ name: name || 'Food', kcal });
  renderToday();
  await saveDay(viewDate);
}

$('#food-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kcal = Math.round(numOrNull($('#food-kcal').value) || 0);
  if (kcal <= 0 || kcal > 5000) return toast('Enter the calories (e.g. 450)');
  const name = $('#food-name').value.trim().slice(0, 60);
  $('#food-name').value = ''; $('#food-kcal').value = '';
  $('#food-kcal').blur();
  await addFood(name, kcal);
});
$('#food-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#food-kcal').focus(); } });

$('#food-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) { const f = recentCache[+b.dataset.i]; addFood(f.name, f.kcal); }
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
    start_weight: +$('#s-start').value, goal_weight: +$('#s-goal').value,
    height_cm: +$('#s-height').value, age: +$('#s-age').value, sex: $('#s-sex').value,
    start_date: $('#s-startdate').value, goal_date: $('#s-goaldate').value,
  };
  if (next.goal_weight >= next.start_weight) return toast('Goal weight should be below your starting weight');
  if (next.goal_date <= next.start_date) return toast('Goal date must be after the start date');
  const first = !profile;
  profile = next;
  try { await saveProfile(); } catch (err) { return toast("Couldn't save: " + err.message); }
  // First time: log the starting weight on the start date so the graph begins there
  if (first && !getDay(next.start_date).weight) { ensureDay(next.start_date).weight = next.start_weight; await saveDay(next.start_date); }
  viewDate = todayStr();
  show('today');
});
$('#setup-cancel').addEventListener('click', () => show('plan'));
$('#edit-goal').addEventListener('click', () => show('setup'));

$('#export').addEventListener('click', () => {
  const rows = [['date', 'weight_kg', 'calories', 'steps', 'active_kcal', 'foods']];
  for (const d of Object.keys(days).sort()) {
    const x = days[d];
    rows.push([d, x.weight ?? '', kcalOf(d) || '', x.steps ?? '', x.active_cal ?? '', x.foods.map((f) => `${f.name} (${f.kcal})`).join('; ')]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `x-fitness-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
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
