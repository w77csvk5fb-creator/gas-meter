'use strict';

// ─────────────────────────────────────────────
// 定数・保存
// ─────────────────────────────────────────────
const KEYS = {
  settings: 'gasMeter.settings',
  trip: 'gasMeter.activeTrip',
  history: 'gasMeter.history',
  bannerClosed: 'gasMeter.bannerClosed',
};
const DEFAULTS = {
  carName: '', kmPerL: 15, pricePerL: 170, autoStart: true, autoStopMin: 5,
  priceUpdatedAt: 0, priceArea: '', priceUrl: '',
};

// gogo.gs の都道府県ページは JIS コード順に /1 〜 /47
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];
const GOGO_ORIGIN = 'https://gogo.gs';

const MAX_ACCURACY_M = 50;        // これより精度の悪い測位は使わない
const MIN_STEP_M = 10;            // これ未満の移動はGPSのブレとみなす
const MAX_SPEED_MS = 70;          // 約250km/h超の移動は誤測位として捨てる
const DRIVE_SPEED_MS = 2.5;       // 約9km/h以上を「車で動いている」とみなす（歩きは含めない）
const START_SPEED_MS = 5.6;       // 自動スタート：直近の平均が約20km/h以上で…
const START_DISTANCE_M = 200;     // …200m以上動いたら走り出したと判定
const START_WINDOW_MS = 60 * 1000;
const STANDBY_BUFFER_MS = 3 * 60 * 1000;     // 動き出した地点をさかのぼるために残す測位
const STANDBY_TIMEOUT_MS = 30 * 60 * 1000;   // 動き出さないまま30分で待機を休止（電池対策）
const AUTO_STOP_MIN_TRIP_M = 200; // ある程度走ってからでないと自動到着しない
const MIN_RECORD_KM = 0.05;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* 保存できなくても動作は続ける */ }
  },
};

let settings = { ...DEFAULTS, ...store.get(KEYS.settings, {}) };
let history = store.get(KEYS.history, []);
let trip = store.get(KEYS.trip, null);

// GPSの状態
let watchId = null;
let wakeLock = null;
let tickTimer = null;
let lastFix = null;      // 最新の測位（精度が悪いものも含む）{ t, acc, speed }
let lastGoodFixAt = 0;   // 精度が十分だった最新の測位時刻
let geoDenied = false;

// 自動スタート待機の状態
let standby = false;       // 走り出しを見張っている
let standbyPaused = false; // 時間切れで見張りを休んでいる
let standbySince = 0;
let standbyFixes = [];

const saveTrip = () => store.set(KEYS.trip, trip);
const saveHistory = () => store.set(KEYS.history, history);
const saveSettings = () => store.set(KEYS.settings, settings);

// ─────────────────────────────────────────────
// 表示用フォーマット
// ─────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const fixed = (n, d) => n.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtKm = (km) => fixed(km, km < 100 ? 2 : 1);
const fmtL = (l) => fixed(l, 2);
const fmtYenNum = (y) => Math.round(y).toLocaleString('ja-JP');
const fmtYen = (y) => '¥' + fmtYenNum(y);
const pad = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtDuration(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}時間${m}分` : `${m}分`;
}
function fmtDate(t) {
  return new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(t) {
  return new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// ─────────────────────────────────────────────
// 計算
// ─────────────────────────────────────────────
function calcFuel(km, s = settings) {
  const liters = km / s.kmPerL;
  return { liters, cost: liters * s.pricePerL };
}

function haversineM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function makeRecord({ km, startedAt, endedAt, source, autoStart = false, autoStop = false }) {
  const { liters, cost } = calcFuel(km);
  return {
    id: newId(), startedAt, endedAt, km, liters, cost, source, autoStart, autoStop,
    kmPerL: settings.kmPerL, pricePerL: settings.pricePerL, carName: settings.carName,
  };
}

// ─────────────────────────────────────────────
// GPS
// ─────────────────────────────────────────────
function ensureWatch() {
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
    });
  }
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
  requestWakeLock(); // 画面が消えるとWebアプリは止まるので点けたままにする
}

function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(tickTimer);
  tickTimer = null;
  releaseWakeLock();
  lastFix = null;
  lastGoodFixAt = 0;
}

function onPosition(pos) {
  const c = pos.coords;
  const t = pos.timestamp || Date.now();
  lastFix = { t, acc: c.accuracy, speed: c.speed };
  if (c.accuracy > MAX_ACCURACY_M) return;
  lastGoodFixAt = t;

  // speed は端末が出す速度（ドップラー）。取れないときは null
  const p = {
    lat: c.latitude, lon: c.longitude, t, acc: c.accuracy,
    speed: c.speed != null && c.speed >= 0 ? c.speed : null,
  };
  if (trip) accumulate(p);
  else if (standby) watchForDeparture(p);
}

function onPositionError(err) {
  if (err.code !== err.PERMISSION_DENIED) return; // タイムアウト等は自動で再試行される
  geoDenied = true;
  stopWatch();
  standby = false;
  if (trip) {
    trip = null;
    saveTrip();
  }
  renderDrive();
  alert('位置情報が許可されていません。\n\niPhoneの「設定」→「プライバシーとセキュリティ」→「位置情報サービス」で、Safari（またはこのアプリ）の位置情報を「使用中のみ」にしてください。');
}

function tick() {
  if (!trip && !standby) return;
  const now = Date.now();
  // しばらく測位が来ないときは1回取りに行く
  if (!lastFix || now - lastFix.t > 20000) {
    navigator.geolocation.getCurrentPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  if (trip) {
    // 自動到着：新しい測位が来ているのに、車の速さで動いていない時間が続いたら
    const limit = settings.autoStopMin * 60000;
    if (limit > 0 && trip.distanceAtDriveM >= AUTO_STOP_MIN_TRIP_M && lastGoodFixAt - trip.lastDriveAt >= limit) {
      // 止まった後に歩いた分などは含めず、最後に車で動いていた時点で締める
      finishTrip({ endedAt: trip.lastDriveAt, distanceM: trip.distanceAtDriveM, autoStop: true });
      return;
    }
  } else if (now - standbySince > STANDBY_TIMEOUT_MS) {
    pauseStandby();
    return;
  }
  renderDrive();
}

// ── 自動スタート待機 ──
function startStandby() {
  if (trip || !settings.autoStart || geoDenied || !('geolocation' in navigator)) return;
  standby = true;
  standbyPaused = false;
  standbySince = Date.now();
  standbyFixes = [];
  ensureWatch();
  renderDrive();
}

function pauseStandby() {
  standby = false;
  standbyPaused = true;
  standbyFixes = [];
  stopWatch();
  renderDrive();
}

function stopStandby() {
  standby = false;
  standbyPaused = false;
  standbyFixes = [];
  if (!trip) stopWatch();
  renderDrive();
}

function watchForDeparture(p) {
  const prev = standbyFixes[standbyFixes.length - 1];
  if (prev && p.t <= prev.t) return;
  // 各点の速度（端末の速度が無ければ前の点からの計算値）
  p.v = p.speed ?? (prev ? haversineM(prev, p) / ((p.t - prev.t) / 1000) : 0);
  standbyFixes.push(p);
  standbyFixes = standbyFixes.filter((f) => p.t - f.t <= STANDBY_BUFFER_MS);

  // 直近1分のどこかの点から、車の速さで200m以上動いていれば走り出したとみなす
  const departed = standbyFixes.some((f) => {
    if (f === p || p.t - f.t > START_WINDOW_MS) return false;
    const d = haversineM(f, p);
    const v = d / ((p.t - f.t) / 1000);
    return d >= START_DISTANCE_M && v >= START_SPEED_MS && v <= MAX_SPEED_MS;
  });
  if (!departed) return;

  // 走り出した地点までさかのぼる：車の速さで着いた点が続く限り前へ
  let i = standbyFixes.length - 1;
  while (i > 0 && standbyFixes[i].v >= DRIVE_SPEED_MS) i--;
  const fixes = standbyFixes.slice(i);

  standby = false;
  standbyFixes = [];
  trip = newTrip(fixes[0].t, true);
  fixes.forEach(accumulate);
  saveTrip();
  toast(`${fmtTime(trip.startedAt)} に動き出したので計測を始めました`);
  renderDrive();
}

// ── 走行中 ──
function newTrip(startedAt, autoStart) {
  return { startedAt, autoStart, distanceM: 0, lastPoint: null, lastDriveAt: startedAt, distanceAtDriveM: 0 };
}

async function startTripManually() {
  if (!('geolocation' in navigator)) {
    toast('この端末では位置情報が使えません');
    return;
  }
  // 通知の許可はボタン操作のときにしか求められないので、ここでも聞いておく
  await requestNotificationPermission();
  geoDenied = false;
  standby = false;
  standbyPaused = false;
  standbyFixes = [];
  trip = newTrip(Date.now(), false);
  saveTrip();
  ensureWatch();
  renderDrive();
}

function accumulate(p) {
  if (!trip.lastPoint) {
    trip.lastPoint = p;
    saveTrip();
    return;
  }
  const d = haversineM(trip.lastPoint, p);
  const dt = (p.t - trip.lastPoint.t) / 1000;
  if (dt <= 0) return;
  const v = d / dt;
  if (v > MAX_SPEED_MS) return; // 瞬間移動 → 誤測位

  if (d < Math.max(MIN_STEP_M, (p.acc + trip.lastPoint.acc) / 2)) {
    // ブレの範囲なので距離には足さないが、端末の速度が車の速さならまだ走行中
    if (p.speed != null && p.speed >= DRIVE_SPEED_MS) {
      markDriving(p.t);
      saveTrip();
    }
    return;
  }

  trip.distanceM += d;
  trip.lastPoint = p;
  // アプリが裏に回っていた間の移動（長い空白のあとに離れた場所）も、走った分として数える
  const gapMove = dt > 60 && d >= 300;
  if ((p.speed ?? v) >= DRIVE_SPEED_MS || gapMove) markDriving(p.t);
  saveTrip();
}

function markDriving(t) {
  trip.lastDriveAt = t;
  trip.distanceAtDriveM = trip.distanceM;
}

function finishTrip({ endedAt = Date.now(), distanceM, autoStop = false } = {}) {
  if (!trip) return;
  const { startedAt, autoStart } = trip;
  const km = (distanceM ?? trip.distanceM) / 1000;
  trip = null;
  saveTrip();

  // 次の走り出しに備えてすぐ待機に戻る
  if (settings.autoStart && document.visibilityState === 'visible') startStandby();
  else stopWatch();
  renderDrive();

  if (km < MIN_RECORD_KM) {
    toast('ほとんど移動していないので記録しませんでした');
    return;
  }
  addRecord(makeRecord({ km, startedAt, endedAt, source: 'gps', autoStart, autoStop }));
}

function addRecord(rec) {
  history.unshift(rec);
  saveHistory();
  renderHistory();
  showResult(rec);
  notify(rec);
}

// ─────────────────────────────────────────────
// 画面スリープ防止
// ─────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* 非対応・拒否時は何もしない */ }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// ─────────────────────────────────────────────
// 通知
// ─────────────────────────────────────────────
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* noop */ }
  }
  renderNotifStatus();
  return Notification.permission;
}

async function notify(rec) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = `ガソリン代 ${fmtYen(rec.cost)}（${fmtL(rec.liters)} L）`;
  const body = `${fmtKm(rec.km)} km 走行・${fmtTime(rec.startedAt)}〜${fmtTime(rec.endedAt)}`
    + `\n燃費 ${rec.kmPerL} km/L・単価 ${rec.pricePerL} 円/L で計算`;
  const options = { body, icon: 'icons/icon-192.png', tag: rec.id };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
  } catch { /* アプリ内の結果表示があるので失敗しても問題なし */ }
}

// ─────────────────────────────────────────────
// 描画
// ─────────────────────────────────────────────
function driveMode() {
  if (trip) return 'driving';
  if (standby) return 'standby';
  return 'idle';
}

function renderDrive() {
  const mode = driveMode();
  document.body.dataset.mode = mode;
  const km = trip ? trip.distanceM / 1000 : 0;
  const { liters, cost } = calcFuel(km);

  $('#meterState').textContent = { driving: '走行中', standby: '自動スタート待機中', idle: '停止中' }[mode];
  $('#liveCost').textContent = fmtYenNum(cost);
  $('#liveKm').textContent = fmtKm(km);
  $('#liveL').textContent = fmtL(liters);
  $('#liveTime').textContent = trip ? fmtClock(Date.now() - trip.startedAt) : '0:00';
  const watching = mode !== 'idle';
  const sp = watching && lastFix && lastFix.speed != null && lastFix.speed >= 0 ? Math.round(lastFix.speed * 3.6) : null;
  $('#liveSpeed').textContent = sp == null ? '—' : String(sp);

  const gps = $('#gpsStatus');
  if (!watching) gps.textContent = '';
  else if (!lastFix) gps.textContent = 'GPS 測位中…';
  else gps.textContent = `GPS ±${Math.round(lastFix.acc)}m`;
  gps.classList.toggle('weak', !!(watching && lastFix && lastFix.acc > MAX_ACCURACY_M));

  $('#tripBtn').textContent = { driving: '到着', standby: '今すぐ出発', idle: '出発' }[mode];

  let hint;
  if (mode === 'driving') {
    hint = settings.autoStopMin > 0
      ? `止まって${settings.autoStopMin}分たつと自動で到着になります。この画面を開いたままにしてください。`
      : 'この画面を開いたままにしてください。着いたら「到着」を押します。';
  } else if (mode === 'standby') {
    hint = '走り出すと自動で計測を始めます。車に乗ったらこの画面を開いたままにしてください。';
  } else if (geoDenied) {
    hint = '位置情報が許可されていないため自動スタートできません。';
  } else if (standbyPaused) {
    hint = '30分動きがなかったので、電池節約のため自動スタートを休んでいます。';
  } else {
    hint = '出発するときに押してください。';
  }
  $('#tripHint').textContent = hint;
  $('#resumeBtn').hidden = !(mode === 'idle' && standbyPaused && settings.autoStart);
  syncFuelInputs();
  renderPriceCheck();
}

// 単価・燃費の入力欄（走行画面と設定画面）を今の値にそろえる。入力中の欄は触らない
function syncFuelInputs() {
  for (const [sel, key] of [['#qPrice', 'pricePerL'], ['#setPrice', 'pricePerL'], ['#qKmPerL', 'kmPerL'], ['#setKmPerL', 'kmPerL']]) {
    const el = $(sel);
    if (document.activeElement !== el) el.value = settings[key];
  }
}

const FUEL_LIMITS = { pricePerL: { min: 1, max: 999, digits: 0 }, kmPerL: { min: 0.1, max: 99.9, digits: 1 } };
function normalizeFuel(key, v) {
  const { min, max, digits } = FUEL_LIMITS[key];
  const f = 10 ** digits;
  return Math.min(max, Math.max(min, Math.round(v * f) / f));
}

function setFuelSetting(key, v) {
  settings[key] = normalizeFuel(key, v);
  if (key === 'pricePerL') settings.priceUpdatedAt = Date.now();
  saveSettings();
  renderDrive();
}

// 単価を最後に見直した日と、gogo.gs の確認先
function renderPriceCheck() {
  const t = settings.priceUpdatedAt;
  $('#priceUpdated').textContent = t
    ? `単価は${new Date(t).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}に更新`
    : '単価はまだ初期値です';
  const link = $('#gogoLink');
  if (settings.priceUrl) {
    link.href = settings.priceUrl;
    link.firstChild.textContent = 'いつものスタンドを見る';
  } else {
    link.href = settings.priceArea ? `${GOGO_ORIGIN}/${settings.priceArea}` : `${GOGO_ORIGIN}/map`;
    link.firstChild.textContent = 'gogo.gsで価格を見る';
  }
}

// 貼り付けられたアドレスが gogo.gs のページなら正規化して返す。違えば null
function parseGogoUrl(text) {
  try {
    const u = new URL(text.trim());
    if (u.protocol !== 'https:' || (u.hostname !== 'gogo.gs' && u.hostname !== 'www.gogo.gs')) return null;
    return u.href;
  } catch { return null; }
}

function renderHistory() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = history.filter((r) => r.endedAt >= monthStart);
  const sum = (key) => month.reduce((a, r) => a + r[key], 0);
  $('#summaryTitle').textContent = `${now.getMonth() + 1}月の合計`;
  $('#sumCost').textContent = fmtYen(sum('cost'));
  $('#sumL').textContent = `${fmtL(sum('liters'))} L`;
  $('#sumKm').textContent = `${fixed(sum('km'), 1)} km`;
  $('#sumCount').textContent = `${month.length} 回`;

  const list = $('#historyList');
  const sorted = [...history].sort((a, b) => b.endedAt - a.endedAt);
  list.replaceChildren(...sorted.map((r) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const date = document.createElement('div');
    date.className = 'h-date';
    date.textContent = r.source === 'manual'
      ? fmtDate(r.endedAt)
      : `${fmtDate(r.startedAt)}〜${fmtTime(r.endedAt)}`;
    if (r.source === 'manual') {
      const tag = document.createElement('span');
      tag.className = 'h-tag';
      tag.textContent = '手入力';
      date.append(tag);
    }
    const main = document.createElement('div');
    main.className = 'h-main';
    main.textContent = `${fmtKm(r.km)} km ・ ${fmtL(r.liters)} L`;
    info.append(date, main);

    const cost = document.createElement('div');
    cost.className = 'h-cost';
    cost.textContent = fmtYen(r.cost);

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.type = 'button';
    del.setAttribute('aria-label', 'この記録を削除');
    del.textContent = '×';
    del.addEventListener('click', () => {
      if (!confirm(`${fmtDate(r.endedAt)} の記録（${fmtYen(r.cost)}）を削除しますか？`)) return;
      history = history.filter((x) => x.id !== r.id);
      saveHistory();
      renderHistory();
    });
    li.append(info, cost, del);
    return li;
  }));
  $('#historyEmpty').hidden = history.length > 0;
}

function renderSettings() {
  $('#setCar').value = settings.carName;
  syncFuelInputs();
  $('#setPriceArea').value = settings.priceArea;
  $('#setPriceUrl').value = settings.priceUrl;
  $('#setAutoStart').value = settings.autoStart ? '1' : '0';
  $('#setAutoStop').value = String(settings.autoStopMin);
  $('#carLabel').textContent = settings.carName;
  renderNotifStatus();
}

function renderNotifStatus() {
  const status = $('#notifStatus');
  const btn = $('#notifBtn');
  const supported = 'Notification' in window;
  btn.hidden = true;
  if (!supported) {
    status.textContent = isIOS && !isStandalone
      ? 'ホーム画面に追加して、そこから開くと通知が使えるようになります。'
      : 'このブラウザは通知に対応していません。結果はアプリ内に表示されます。';
  } else if (Notification.permission === 'granted') {
    status.textContent = 'オン：到着するとガソリン代を通知します。';
  } else if (Notification.permission === 'denied') {
    status.textContent = 'オフ：iPhoneの「設定」→「通知」→「ガソリン代」から許可できます。';
  } else {
    status.textContent = '到着したときにガソリン代を通知できます。';
    btn.hidden = false;
  }
  // 自動スタートでは「出発」を押さないので、許可を求める場所を走行画面にも出す
  $('#notifPrompt').hidden = !(supported && Notification.permission === 'default');
}

function showResult(rec) {
  $('#resultTitle').textContent = rec.autoStop ? '到着したようです' : rec.source === 'manual' ? '記録しました' : 'おつかれさまでした';
  $('#resultCost').textContent = fmtYenNum(rec.cost);
  $('#resultL').textContent = `${fmtL(rec.liters)} L`;
  $('#resultKm').textContent = `${fmtKm(rec.km)} km`;
  $('#resultTime').textContent = rec.source === 'manual'
    ? '—'
    : `${fmtTime(rec.startedAt)}〜${fmtTime(rec.endedAt)}（${fmtDuration(rec.endedAt - rec.startedAt)}）`;
  $('#resultBasis').textContent = `${rec.kmPerL} km/L・${rec.pricePerL} 円/L`;
  const dlg = $('#resultDialog');
  if (dlg.open) dlg.close();
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else alert(`ガソリン代 ${fmtYen(rec.cost)}（${fmtL(rec.liters)} L）`);
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistory();
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────────
// イベント
// ─────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

$('#tripBtn').addEventListener('click', () => {
  if (!trip) startTripManually();
  else if (confirm('到着として記録しますか？')) finishTrip();
});
$('#resumeBtn').addEventListener('click', startStandby);

$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#manualKm');
  const km = parseFloat(input.value);
  if (!(km > 0)) {
    toast('走行距離を入力してください');
    return;
  }
  const now = Date.now();
  addRecord(makeRecord({ km, startedAt: now, endedAt: now, source: 'manual' }));
  input.value = '';
  input.blur();
});

function bindFuelInput(sel, key) {
  $(sel).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) setFuelSetting(key, v);
  });
  // 不正な値のまま離れたら今の値に戻す
  $(sel).addEventListener('blur', () => syncFuelInputs());
}
bindFuelInput('#qPrice', 'pricePerL');
bindFuelInput('#setPrice', 'pricePerL');
bindFuelInput('#qKmPerL', 'kmPerL');
bindFuelInput('#setKmPerL', 'kmPerL');
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.key;
  setFuelSetting(key, settings[key] + Number(b.dataset.step));
}));
$('#setCar').addEventListener('input', (e) => {
  settings.carName = e.target.value.trim();
  saveSettings();
  $('#carLabel').textContent = settings.carName;
});
$('#setPriceArea').append(...PREFECTURES.map((name, i) => new Option(name, String(i + 1))));
$('#setPriceArea').addEventListener('change', (e) => {
  settings.priceArea = e.target.value;
  saveSettings();
  renderPriceCheck();
});
$('#setPriceUrl').addEventListener('change', (e) => {
  const text = e.target.value.trim();
  const url = text ? parseGogoUrl(text) : '';
  if (url == null) {
    toast('gogo.gs のページのアドレスを貼り付けてください');
    e.target.value = settings.priceUrl;
    return;
  }
  settings.priceUrl = url;
  e.target.value = url;
  saveSettings();
  renderPriceCheck();
});
$('#setAutoStart').addEventListener('change', (e) => {
  settings.autoStart = e.target.value === '1';
  saveSettings();
  if (settings.autoStart) startStandby();
  else stopStandby();
});
$('#setAutoStop').addEventListener('change', (e) => {
  settings.autoStopMin = Number(e.target.value);
  saveSettings();
  renderDrive();
});

$('#notifBtn').addEventListener('click', requestNotificationPermission);
$('#notifPromptBtn').addEventListener('click', requestNotificationPermission);

$('#clearBtn').addEventListener('click', () => {
  if (!history.length) return toast('履歴はありません');
  if (!confirm(`履歴 ${history.length} 件をすべて削除します。元に戻せません。よろしいですか？`)) return;
  history = [];
  saveHistory();
  renderHistory();
  toast('履歴を削除しました');
});

$('#bannerClose').addEventListener('click', () => {
  $('#installBanner').hidden = true;
  store.set(KEYS.bannerClosed, true);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (trip) requestWakeLock(); // 裏に回ると解除されるので取り直す
  else startStandby();         // アプリを開き直したら待機を再開（休止中でも）
  renderDrive();
});

// ─────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (isIOS && !isStandalone && !store.get(KEYS.bannerClosed, false)) {
  $('#installBanner').hidden = false;
}

// 古い形式で保存された走行中データを補う
if (trip && trip.lastDriveAt == null) {
  trip.lastDriveAt = trip.lastMoveAt ?? trip.startedAt;
  trip.distanceAtDriveM = trip.distanceM;
}

renderSettings();
renderDrive();
renderHistory();
if (location.hash === '#history') showView('history');
// アプリが閉じられていても、走行中だったら計測を再開。そうでなければ走り出しを待つ
if (trip) ensureWatch();
else startStandby();
