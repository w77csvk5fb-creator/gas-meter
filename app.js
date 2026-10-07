'use strict';

// ─────────────────────────────────────────────
// 定数・保存
// ─────────────────────────────────────────────
const KEYS = {
  settings: 'gasMeter.settings',
  history: 'gasMeter.history',
  bannerClosed: 'gasMeter.bannerClosed',
};
const DEFAULTS = {
  carName: '', kmPerL: 15, pricePerL: 170,
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
const MAX_KM = 9999;

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

// 以前の版で使っていた設定（自動スタートなど）は読み込み時に捨てる
const saved = store.get(KEYS.settings, {});
let settings = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, saved[k] ?? DEFAULTS[k]]));
let history = store.get(KEYS.history, []);
try { localStorage.removeItem('gasMeter.activeTrip'); } catch { /* noop */ }

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

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function makeRecord(km) {
  const now = Date.now();
  const { liters, cost } = calcFuel(km);
  return {
    id: newId(), startedAt: now, endedAt: now, km, liters, cost, source: 'manual',
    kmPerL: settings.kmPerL, pricePerL: settings.pricePerL, carName: settings.carName,
  };
}

// 入力中の距離。数字でない・0以下・大きすぎるときは null
function enteredKm() {
  const km = parseFloat($('#distKm').value);
  return km > 0 && km <= MAX_KM ? km : null;
}

// ─────────────────────────────────────────────
// 単価・燃費
// ─────────────────────────────────────────────
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
  renderCalc();
}

// 単価・燃費の入力欄（計算画面と設定画面）を今の値にそろえる。入力中の欄は触らない
function syncFuelInputs() {
  for (const [sel, key] of [['#qPrice', 'pricePerL'], ['#setPrice', 'pricePerL'], ['#qKmPerL', 'kmPerL'], ['#setKmPerL', 'kmPerL']]) {
    const el = $(sel);
    if (document.activeElement !== el) el.value = settings[key];
  }
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

// ─────────────────────────────────────────────
// 描画
// ─────────────────────────────────────────────
function renderCalc() {
  const km = enteredKm() ?? 0;
  const { liters, cost } = calcFuel(km);
  $('#liveCost').textContent = fmtYenNum(cost);
  $('#liveL').textContent = fmtL(liters);
  $('#recordBtn').disabled = km === 0;
  syncFuelInputs();
  renderPriceCheck();
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
    // 以前の版のGPS計測の記録は、出発〜到着の時刻で表示する
    date.textContent = r.source === 'manual'
      ? fmtDate(r.endedAt)
      : `${fmtDate(r.startedAt)}〜${fmtTime(r.endedAt)}`;
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
  $('#setPriceArea').value = settings.priceArea;
  $('#setPriceUrl').value = settings.priceUrl;
  $('#carLabel').textContent = settings.carName;
  syncFuelInputs();
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

$('#distKm').addEventListener('input', renderCalc);

$('#calcForm').addEventListener('submit', (e) => {
  e.preventDefault();
  // 単価・燃費の欄で改行キーを押したときは記録しない
  const from = document.activeElement;
  if (from && from.classList.contains('step-input')) {
    from.blur();
    return;
  }
  const km = enteredKm();
  if (km == null) {
    toast('走行距離を入力してください');
    return;
  }
  const rec = makeRecord(km);
  history.unshift(rec);
  saveHistory();
  renderHistory();
  toast(`記録しました：${fmtKm(km)} km ・ ${fmtYen(rec.cost)}`);
  $('#distKm').value = '';
  $('#distKm').blur();
  renderCalc();
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

// ─────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
if (isIOS && !isStandalone && !store.get(KEYS.bannerClosed, false)) {
  $('#installBanner').hidden = false;
}

saveSettings();
renderSettings();
renderCalc();
renderHistory();
if (location.hash === '#history') showView('history');
