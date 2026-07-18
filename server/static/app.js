/* ── CONFIG ──────────────────────────────────────────────── */
let BASE_URL = 'https://web-production-a4abd.up.railway.app/';
let POLL_INTERVAL = 5000;
let isTicking = false;

const CFG = {
  warnPower: 1000, highPower: 2200, shortPower: 3000,
  didtShort: 50, tw: 10, nmin: 3, don: 50, tfluk: 200
};

/* ── DATA STORES ─────────────────────────────────────────── */
const HISTORY_SIZE = 180;
const stores = {
  voltage:   { data: [], labels: [], unit: 'V',    name: 'Tegangan' },
  current:   { data: [], labels: [], unit: 'A',    name: 'Arus' },
  power:     { data: [], labels: [], unit: 'W',    name: 'Daya Aktif' },
  frequency: { data: [], labels: [], unit: 'Hz',   name: 'Frekuensi' },
  pf:        { data: [], labels: [], unit: 'cos φ',name: 'Faktor Daya' },
  kwh:       { data: [], labels: [], unit: 'kWh',  name: 'Energi' },
};

let logEntries = [];
let lastPower = 0;
let cycleHistory = [];
let cycleTransitions = 0;
let activeBeban = null;
let pollTimer = null;
let activeAlat = null;
let testingActive = false;
let pengujianAktif = false;
let lastDataTime = Date.now();
let namaAlatAktif = "";

const alatStore = {};

/* ── BEBAN DEFINITIONS ───────────────────────────────────── */
const BEBAN_LIST = [
  {
    id: 1, name: 'Lampu LED', icon: '💡',
    nominalPower: 50, nominalCurrent: 0.23,
    type: 'stabil', typeLabel: 'Stabil',
    spec: '50 W · Beban resistif stabil',
    color: '#22c55e',
    simulate: (t) => ({
      power: 50 + Math.sin(t * 0.1) * 1.5,
      current: 0.23 + Math.sin(t * 0.1) * 0.007,
      voltage: 219 + Math.sin(t * 0.05) * 1,
    })
  },
  {
    id: 2, name: 'Kipas Angin', icon: '🌀',
    nominalPower: 57, nominalCurrent: 0.26,
    type: 'fluktuatif', typeLabel: 'Fluktuatif',
    spec: '45–70 W · Beban kontinu variabel',
    color: '#3b82f6',
    simulate: (t) => ({
      power: 57 + Math.sin(t * 0.3) * 12 + (Math.random() - 0.5) * 4,
      current: 0.26 + Math.sin(t * 0.3) * 0.05,
      voltage: 219.5 + (Math.random() - 0.5) * 2,
    })
  },
  {
    id: 3, name: 'Rice Cooker', icon: '🍚',
    nominalPower: 350, nominalCurrent: 1.59,
    type: 'cycling', typeLabel: 'Cycling',
    spec: '300–400 W · Device cycling termostat',
    color: '#f59e0b',
    simulate: (t) => {
      const cycle = Math.floor(t / 40) % 2 === 0;
      const p = cycle ? 350 + (Math.random() - 0.5) * 20 : 8 + Math.random() * 3;
      return { power: p, current: p / 220, voltage: 220 + (Math.random() - 0.5) * 1.5 };
    }
  },
  {
    id: 4, name: 'Setrika Listrik', icon: '🔌',
    nominalPower: 375, nominalCurrent: 1.70,
    type: 'periodik', typeLabel: 'Periodik',
    spec: '300–450 W · Pemanas periodik',
    color: '#f97316',
    simulate: (t) => {
      const cycle = Math.sin(t * 0.15) > 0;
      const p = cycle ? 400 + (Math.random() - 0.5) * 50 : 6 + Math.random() * 2;
      return { power: p, current: p / 220, voltage: 219 + (Math.random() - 0.5) * 2 };
    }
  },
  {
    id: 5, name: 'Power Amplifier', icon: '🔊',
    nominalPower: 350, nominalCurrent: 1.59,
    type: 'fluktuatif', typeLabel: 'Fluktuatif',
    spec: '200–500 W · Beban fluktuatif tinggi',
    color: '#8b5cf6',
    simulate: (t) => {
      const p = 350 + Math.sin(t * 0.8) * 150 + (Math.random() - 0.5) * 60;
      return { power: Math.max(200, p), current: p / 220, voltage: 218 + (Math.random() - 0.5) * 3 };
    }
  },
  {
    id: 6, name: 'Kulkas', icon: '🧊',
    nominalPower: 200, nominalCurrent: 0.91,
    type: 'periodik', typeLabel: 'Periodik',
    spec: '100–300 W · Kompresor periodik',
    color: '#06b6d4',
    simulate: (t) => {
      const period = 60;
      const onPhase = t % period < 30;
      const p = onPhase ? 200 + (Math.random() - 0.5) * 40 : 12 + Math.random() * 3;
      return { power: p, current: p / 220, voltage: 220 + (Math.random() - 0.5) * 1 };
    }
  }
];

/* ── PER-BEBAN ISOLATED STORE ────────────────────────────── */
// Setiap beban punya data history & nama alat sendiri
// Data beban lain TIDAK ikut berubah saat salah satu diuji
const bebanStore = {};
function getAlatStore(namaAlat) {

  if (!alatStore[namaAlat]) {

    alatStore[namaAlat] = {
      power: [],
      current: [],
      voltage: [],
      labels: []
    };

  }

  return alatStore[namaAlat];
}

function getBebanStore(idx) {

    if (!bebanStore[idx]) {

        bebanStore[idx] = {
            power: [],
            current: [],
            voltage: [],
            labels: [],
            status: [],
            confidence: [],
            deltaP: [],        // BARU
            cycling: [],       // BARU
            cyclePeriod: [],   // BARU
            namaAlat: BEBAN_LIST[idx].name
        };

    }

    return bebanStore[idx];
}

// Dipanggil setiap tick — hanya simpan ke beban aktif
function recordToActiveBeban(data) {

  console.log(
      "recordToActiveBeban",
      "aktif =", pengujianAktif,
      "beban =", activeBeban,
      "power =", data.power
  );

  if (!pengujianAktif) return;

  if (activeBeban === null) return;

  const store = getBebanStore(activeBeban);

  const now = new Date().toLocaleTimeString('id-ID', {
      hour12:false
  });

  store.power.push(Number(data.power));
  store.current.push(Number(data.current));
  store.voltage.push(Number(data.voltage));
  store.labels.push(now);

  store.status.push(data.status || "NORMAL");
  store.confidence.push(isNaN(data.confidence) ? 0 : data.confidence);

  store.deltaP.push(Number(data.deltaP || 0));           // BARU
  store.cycling.push(!!data.cycling);                    // BARU
  store.cyclePeriod.push(data.cyclePeriod || null);      // BARU

  console.log("DATA TERSIMPAN =", store.power.length);
 
  if (store.power.length > 180) {

    store.power.shift();
    store.current.shift();
    store.voltage.shift();
    store.labels.shift();

    store.status.shift();
    store.confidence.shift();
    store.deltaP.shift();        // BARU
    store.cycling.shift();       // BARU
    store.cyclePeriod.shift();   // BARU

}
}

/* ── CHART INSTANCES ─────────────────────────────────────── */
const charts = {};
const sparklines = {};

/* ── CHART DEFAULTS ──────────────────────────────────────── */
Chart.defaults.color = '#64748b';
Chart.defaults.font.family = "'DM Mono', monospace";
Chart.defaults.font.size = 10;

function chartDefaults(color = '#00d4aa') {
  return {
    borderColor: color,
    backgroundColor: color + '18',
    borderWidth: 1.5,
    pointRadius: 0,
    fill: true,
    tension: 0.4,
  };
}

/* ── INIT CHARTS ─────────────────────────────────────────── */
function initMainChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');
  charts.main = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Daya (W)', ...chartDefaults('#00d4aa') }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { display: false },
        y: { min: 0, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', maxTicksLimit: 5, font: { size: 10 } } }
      }
    }
  });
}
/* ── INIT CHARTS ─────────────────────────────────────────── */

function initMainChart() {

    const canvas = document.getElementById('mainChart');
    if (!canvas) return;

    // Hindari chart ganda
    if (charts.main) {
        charts.main.destroy();
        charts.main = null;
    }

    const ctx = canvas.getContext('2d');

    charts.main = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Daya (W)',
                ...chartDefaults('#00d4aa'),
                data: []
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 200
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                x: {
                    display: false
                },
                y: {
                    min: 0,
                    grid: {
                        color: 'rgba(255,255,255,0.05)'
                    },
                    ticks: {
                        color: '#64748b',
                        maxTicksLimit: 5,
                        font: {
                            size: 10
                        }
                    }
                }
            }
        }
    });

    console.log("Main chart initialized");
}

function initHistChart() {

    const canvas = document.getElementById('histChart');
    if (!canvas) {
        console.log("Canvas histChart tidak ditemukan");
        return;
    }

    // Hindari chart ganda
    if (charts.hist) {
        charts.hist.destroy();
        charts.hist = null;
    }

    const ctx = canvas.getContext('2d');

    charts.hist = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Daya (W)',
                    ...chartDefaults('#00d4aa'),
                    data: []
                },
                {
                    label: 'Arus (A)×100',
                    ...chartDefaults('#3b82f6'),
                    data: []
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#3d4a60',
                        font: {
                            size: 9
                        }
                    },
                    grid: {
                        color: 'rgba(255,255,255,0.04)'
                    }
                },
                y: {
                    grid: {
                        color: 'rgba(255,255,255,0.05)'
                    },
                    ticks: {
                        color: '#64748b',
                        maxTicksLimit: 5
                    }
                }
            }
        }
    });

    console.log("Hist chart initialized");
}

function initSparkline(param, color = '#00d4aa') {
  const canvas = document.getElementById('spk' + paramKey(param));
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  sparklines[param] = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ ...chartDefaults(color), data: [] }] },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      elements: { point: { radius: 0 } }
    }
  });
}

function paramKey(param) {
  return { voltage: 'V', current: 'A', power: 'W', frequency: 'Hz', pf: 'PF', kwh: 'Kwh' }[param] || 'V';
}

const spkColors = {
  voltage: '#00d4aa', current: '#3b82f6', power: '#f97316',
  frequency: '#8b5cf6', pf: '#22c55e', kwh: '#f59e0b'
};

function initAllSparklines() {
  Object.keys(stores).forEach(p => initSparkline(p, spkColors[p]));
}

/* ── DATA PUSH ───────────────────────────────────────────── */
function pushData(param, value, label) {
  const s = stores[param];
  s.data.push(value);
  s.labels.push(label);
  if (s.data.length > HISTORY_SIZE) { s.data.shift(); s.labels.shift(); }
}

function updateSparkline(param) {
  const sp = sparklines[param];
  if (!sp) return;
  const s = stores[param];
  const last30 = s.data.slice(-30);
  sp.data.labels = last30.map(() => '');
  sp.data.datasets[0].data = last30;
  sp.update('none');
}

/* ── SIMULATION DATA ─────────────────────────────────────── */
let simTick = 0;
function generateSimData() {
  simTick++;
  if (activeBeban !== null) {
    const b = BEBAN_LIST[activeBeban];
    const raw = b.simulate(simTick);
    const p = +raw.power.toFixed(1);
    const a = +raw.current.toFixed(3);
    const v = +raw.voltage.toFixed(1);
    const status = classifyStatus(p, a, v);
    return {
      voltage: v, current: a, power: p,
      frequency: +(50 + (Math.random() - 0.5) * 0.15).toFixed(2),
      pf: +(0.94 + Math.random() * 0.05).toFixed(2),
      kwh: +(0.42 + simTick * 0.00003).toFixed(4),
      status, ai: status === 'NORMAL' || status === 'NO_LOAD' ? 'AMAN' : 'WASPADA',
      pln: true, relay: status !== 'SHORT_CIRCUIT' && status !== 'HIGH_CONSUMPTION',
      deltaP: +(p - lastPower).toFixed(2),
      cycling: b.type === 'cycling' || b.type === 'periodik',
      cycleCount: b.type === 'cycling' ? Math.floor(simTick / 40) % 10 : 0,
      cyclePeriod: b.type === 'cycling' ? 40 : null,
      cycleDevice: b.type === 'cycling' || b.type === 'periodik' ? b.name : null,
    };
  }
  const p = +(14.8 + Math.sin(simTick * 0.08) * 3 + (Math.random() - 0.5) * 2).toFixed(1);
  const v = +(219.2 + (Math.random() - 0.5) * 1.5).toFixed(1);
  return {
    voltage: v, current: +(p / v).toFixed(3), power: p,
    frequency: +(50 + (Math.random() - 0.5) * 0.1).toFixed(2),
    pf: +(0.97 + Math.random() * 0.02).toFixed(2),
    kwh: +(0.42 + simTick * 0.00001).toFixed(4),
    status: 'NORMAL', ai: 'AMAN', pln: true, relay: true,
    deltaP: +(p - lastPower).toFixed(2),
    cycling: false, cycleCount: 0, cyclePeriod: null, cycleDevice: null,
  };
}

function detectCycling(power) {
  cycleHistory.push(power);
  if (cycleHistory.length > 8) cycleHistory.shift();
  let transitions = 0;
  for (let i = 1; i < cycleHistory.length; i++) {
    const prev = cycleHistory[i - 1];
    const curr = cycleHistory[i];
    if (Math.abs(curr - prev) > 150) transitions++;
    if (prev > 100 && curr < 20) transitions++;
  }
  cycleTransitions = transitions;
  return transitions >= 3;
}

let shortCounter = 0;
function classifyStatus(p, a, v) {
  if (v <= 10) return 'PLN_OFFLINE';
  const shortDetected = p > CFG.shortPower || (Math.abs(p - lastPower) > 800 && a > 5 && v < 200);
  if (shortDetected) shortCounter++; else shortCounter = 0;
  if (shortCounter >= 2) return 'SHORT_CIRCUIT';
  if (p > CFG.highPower) return 'HIGH_CONSUMPTION';
  if (p > CFG.warnPower) return 'WARNING';
  if (p < 5 && a < 0.05) return 'NO_LOAD';
  return 'NORMAL';
}

function initNotification() {
  if (!("Notification" in window)) {
    console.log("Browser tidak support notif");
    return;
  }

  if (Notification.permission === "default") {
    Notification.requestPermission().then((permission) => {
      console.log("Permission notif:", permission);
    });
  }
}

function showNotif(title, body) {

    console.log("SHOW NOTIF:", title, body);

    if (Notification.permission !== "granted") {
        console.log("Permission belum granted");
        return;
    }

    const notif = new Notification(title, {
        body: body
    });

    notif.onclick = () => {
        console.log("Notif diklik");
    };

    console.log("Notif berhasil dibuat");
}

function cekStatus(data) {
    console.log("STATUS SEKARANG :", data.status);
    console.log("STATUS LAMA :", lastStatus);
    if (!data) return;

    // Status PLN berubah
    if (lastPLN !== data.pln) {

        if (data.pln) {
            showNotif("✅ Smart KUPIT", "Kondisi listrik kembali normal");
        } else {
            showNotif("⚡ PLN MATI", "Tegangan PLN terputus");
        }

        lastPLN = data.pln;
    }

    // Status sistem berubah
    if (lastStatus !== data.status) {

        switch (data.status) {

            case "WARNING":
                showNotif("⚠ Smart KUPIT", "Daya melebihi batas warning");
                break;

            case "HIGH_CONSUMPTION":
                showNotif("🔥 Konsumsi Tinggi", "Pemakaian listrik tinggi");
                break;

            case "SHORT_CIRCUIT":
                showNotif("🚨 Hubung Singkat", "Relay diputus otomatis");
                break;

            case "NORMAL":
                showNotif("✅ Smart KUPIT", "Kondisi listrik kembali normal");
                break;
        }

        lastStatus = data.status;
    }
}
let lastStatus = "";
let lastPLN = null;


/* ── FETCH / POLL ────────────────────────────────────────── */
async function fetchLatest() {
  const controller = new AbortController();

const timeoutId = setTimeout(() => {
    controller.abort();
}, 7000);
  try {
    const res = await fetch(
    `${BASE_URL}/api/latest?t=${Date.now()}`,
    {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
    }
);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json(); 
    clearTimeout(timeoutId);
    if (!result) throw new Error("Response kosong");
    const data = result.data || result;
    lastDataTime = data.status !== 'ESP_OFFLINE'
    ? Date.now()
    : 0;
clearTimeout(timeoutId);
const power = Number(data.power || 0);
const current = Number(data.current || 0);
const voltage = Number(data.voltage || 0);

let frequency = Number(data.frequency || 0);
let pf = Number(data.pf || 0);
let kwh = Number(data.kwh || 0);
let confidence = Number(data.confidence || 0);

if (voltage < 10) {
    frequency = 0;
    pf = 0;
}

    const cyclingDetected = data.deviceCycling ?? false;

    // Gunakan status dari ESP32
    let finalStatus = data.status || "NORMAL";

    // Jika Javascript mendeteksi cycling sementara status masih NORMAL
    if (cyclingDetected && finalStatus === "NORMAL") {
        finalStatus = "CYCLING_DETECTED";
    }

    // Gunakan status relay dari ESP32
    const relayState = data.relay;
    return {
      voltage,
      current,
      power,
      frequency: frequency,
      pf: pf,
      kwh: kwh,
      confidence: confidence,
      status: finalStatus,
      relay: relayState,
      pln: data.pln,
      deltaP: Number(data.deltaPower || 0),
      cycling: data.deviceCycling || cyclingDetected,
      cycleCount: cycleTransitions,
      cyclePeriod: data.cyclePeriod || null
    };
  } catch (err) {
    console.error("FETCH ERROR:", err);
    return { voltage: 0, current: 0, power: 0, frequency: 0, pf: 0, kwh: 0,
      status: 'ESP_OFFLINE', relay: false, pln: false, deltaP: 0,
      cycling: false, cycleCount: 0, cyclePeriod: null };
  }
}

/* ── RENDER ──────────────────────────────────────────────── */
function render(data) {
  updateTimestamp();
  updateLastUpdate();
  updateMetricCards(data);
  updateStatusBadge(data);
  updateMainChart(data.power);
  updateDetectionPanel(data);
  updateCostPanel(data);
  checkAlerts(data);
  lastPower = data.power;
}

function updateTimestamp() {
  const now = new Date();
  document.getElementById('tsDate').textContent =
    now.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('tsTime').textContent =
    now.toLocaleTimeString('id-ID', { hour12: false });
}

function updateLastUpdate() {
  const el = document.getElementById('lastUpdate');
  if (!el) return;
  el.textContent = 'Last update: ' + new Date().toLocaleTimeString();
}

function updateMetricCards(data) {
  const now = new Date().toLocaleTimeString('id-ID', { hour12: false });
  if (data.voltage < 10) {
    data.frequency = 0;
    data.pf = 0;
}
  const params = [
    { key: 'voltage',   val: data.voltage,   elId: 'mV',   minId: 'mVmin',   maxId: 'mVmax' },
    { key: 'current',   val: data.current,   elId: 'mA',   minId: 'mAmin',   maxId: 'mAmax' },
    { key: 'power',     val: data.power,     elId: 'mW',   minId: 'mWmin',   maxId: 'mWmax' },
    { key: 'frequency', val: data.frequency, elId: 'mHz',  minId: 'mHzmin',  maxId: 'mHzmax' },
    { key: 'pf',        val: data.pf,        elId: 'mPF',  minId: 'mPFmin',  maxId: 'mPFmax' },
    { key: 'kwh',       val: data.kwh,       elId: 'mKwh', minId: 'mKwhmin', maxId: 'mKwhmax' },
  ];
  params.forEach(({ key, val, elId, minId, maxId }) => {
    pushData(key, val, now);
    const el = document.getElementById(elId);
    if (el) el.textContent = val;
    const s = stores[key];
    if (s.data.length > 1) {
      const mn = Math.min(...s.data).toFixed(key === 'pf' ? 2 : 1);
      const mx = Math.max(...s.data).toFixed(key === 'pf' ? 2 : 1);
      const minEl = document.getElementById(minId);
      const maxEl = document.getElementById(maxId);
      if (minEl) minEl.textContent = `Min: ${mn}`;
      if (maxEl) maxEl.textContent = `Max: ${mx}`;
    }
    //updateSparkline(key);
  });
}

function updateStatusBadge(data) {
  const deviceStatus = document.getElementById('statusLabel');
  const statusDot = document.getElementById('statusDot');

  // ===== CEK ESP ONLINE/OFFLINE =====
  const espOnline =
    (Date.now() - lastDataTime) < 10000; // offline jika tidak ada data >10 detik

  if (espOnline) {
    deviceStatus.textContent = 'ESP32 Online';
    statusDot.style.background = '#22c55e';
  } else {
    deviceStatus.textContent = 'ESP32 Offline';
    statusDot.style.background = 'red';
  }

  // ===== KODE LAMA TETAP =====
  const s = data.status || 'NORMAL';
  const badge = document.getElementById('topBadge');
  const badgeText = document.getElementById('topBadgeText');

  badge.className = 'status-badge-top';

  if (s === 'WARNING') badge.classList.add('warning');
  else if (s === 'HIGH_CONSUMPTION') badge.classList.add('high');
  else if (s === 'SHORT_CIRCUIT') badge.classList.add('danger');
  else if (s === 'CYCLING_DETECTED') badge.classList.add('warning');
  else if (s === 'ESP_OFFLINE') badge.classList.add('danger');
  else if (s === 'PLN_OFFLINE') badge.classList.add('warning');

  badgeText.textContent = s.replaceAll('_', ' ');

  const relayDot = document.getElementById('relayDot');
  const relayLabel = document.getElementById('relayLabel');
  const relayTitle = document.getElementById('relayTitle');

  if (data.relay === true) {
    relayDot.className = 'relay-dot protect';
    relayLabel.textContent = 'PROTECT';
    relayTitle.textContent = 'LISTRIK DIPUTUS';
  } else {
    relayDot.className = 'relay-dot normal';
    relayLabel.textContent = 'NORMAL';
    relayTitle.textContent = 'LISTRIK NORMAL';
  }

  const plnPill = document.getElementById('plnPill');
  const plnActive = data.pln;

  if (plnActive) {
      plnPill.textContent = 'PLN MENYALA';
      plnPill.className = 'pln-pill';
  } else {
      plnPill.textContent = 'PLN MATI';
      plnPill.className = 'pln-pill off';
  }
}

function updateMainChart(power) {
  if (!charts.main) return;
  const now = new Date().toLocaleTimeString('id-ID', { hour12: false });
  const maxPts = 90;
  if (charts.main.data.labels.length >= maxPts) {
    charts.main.data.labels.shift();
    charts.main.data.datasets[0].data.shift();
  }
  charts.main.data.labels.push(now);
  charts.main.data.datasets[0].data.push(power);
  charts.main.update('none');
}

function updateDetectionPanel(data) {

  const dp = Number(data.deltaP || 0);

  setEl('detRule', data.status || 'NORMAL');

  setEl(
    'detDelta',
    (dp >= 0 ? '+' : '') + dp.toFixed(2) + ' W'
  );

  const abnormal = Math.abs(dp) > CFG.tfluk;

  setElClass(
    'detFluk',
    abnormal ? 'red' : 'green',
    abnormal ? 'Ya' : 'Tidak'
  );

  setElClass(
    'detCycle',
    data.cycling ? 'amber' : '',
    data.cycling ? 'Terdeteksi' : 'Tidak ada'
  );

  setEl(
    'detCycleCount',
    data.cycleCount ?? '-'
  );

  setEl(
    'detCyclePeriod',
    data.cyclePeriod
      ? data.cyclePeriod + ' detik'
      : '-'
  );

}

function updateCostPanel(data) {
  const tarif = 1444.7;
  const biayaPerJam = (data.power / 1000) * tarif;
  const biayaPerDetik = biayaPerJam / 3600;
  const kwh = data.kwh || 0;
  const totalBiaya = kwh * tarif;
  const bulanIni = totalBiaya * 0.3;
  const prediksi = totalBiaya * 1.2;
  const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
  document.getElementById('costTotal').textContent = rupiah(totalBiaya);
  document.getElementById('costMonth').textContent = rupiah(bulanIni);
  document.getElementById('costPredict').textContent = rupiah(prediksi);
  const realtimeEl =
  document.getElementById('costRealtimeText');
  const confidence = Number(data.confidence || 0);
  document.getElementById("costConf").textContent =
confidence > 0
? confidence.toFixed(2)+"%"
: "Tidak tersedia";
  const trendBadge = document.getElementById('trendBadge');
  if (data.power > 1500) { trendBadge.textContent = 'TINGGI'; trendBadge.className = 'trend-badge danger'; }
  else if (data.power > 800) { trendBadge.textContent = 'NAIK'; trendBadge.className = 'trend-badge warning'; }
  else { trendBadge.textContent = 'STABIL'; trendBadge.className = 'trend-badge'; }
}

let lastNotifStatus = '';
let lastNotifTime = 0;
let notifLock = false;

function sendNotification(title, body) {

  if (Notification.permission !== "granted") return;

  navigator.serviceWorker.ready
    .then(reg => {

      return reg.showNotification(title, {
        body: body,
        requireInteraction: true,
        renotify: true,
        tag: Date.now().toString(),
        vibrate: [300, 200, 300]
      });

    })
    .catch(err => console.error(err));

}

function checkAlerts(data) {

  const s = data.status;

  // HANYA KIRIM JIKA STATUS BERUBAH
  if (s === lastNotifStatus) return;

  switch (s) {

    case "WARNING":
      sendNotification(
        "⚠️ SmartKWH Warning",
        `Daya melebihi batas warning (${data.power} W)`
      );
      break;

    case "HIGH_CONSUMPTION":
      sendNotification(
        "🔥 Konsumsi Tinggi",
        `Pemakaian listrik tinggi (${data.power} W)`
      );
      break;

    case "SHORT_CIRCUIT":
      sendNotification(
        "🚨 Hubung Singkat",
        "Terdeteksi kemungkinan korsleting"
      );
      break;

    case "PLN_OFFLINE":
      sendNotification(
        "🔌 PLN Mati",
        "Tegangan PLN terputus"
      );
      break;

    case "ESP_OFFLINE":
      sendNotification(
        "📡 ESP32 Offline",
        "Perangkat tidak terhubung"
      );
      break;

    case "NORMAL":
      sendNotification(
        "✅ SmartKWH",
        "Kondisi listrik kembali normal"
      );
      break;
  }

  lastNotifStatus = s;
}

function addLog(data) {
  const s = data.status;
  if (!s || s === 'NORMAL' || s === 'NO_LOAD') return;
  const now = new Date();
  const lastLog = logEntries[0];
  if (lastLog) {
    const lastTime = new Date(lastLog.rawTime || 0);
    const diffSec = (now - lastTime) / 1000;
    if (lastLog.status === s && diffSec < 5) return;
  }
  logEntries.unshift({
    rawTime: now, time: now.toLocaleString('id-ID'),
    status: s, power: data.power, current: data.current,
    voltage: data.voltage, ai: data.ai || '—'
  });
  if (logEntries.length > 200) logEntries.pop();
  renderLogs(currentFilter);
}

function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setElClass(id, cls, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.className = 'det-val' + (cls ? ' ' + cls : '');
}

/* ── LOG TABLE ───────────────────────────────────────────── */
let currentFilter = 'ALL';

function renderLogs(filter) {
  currentFilter = filter;
  const tbody = document.getElementById('logBody');
  if (!tbody) return;
  const filtered = filter === 'ALL' ? logEntries : logEntries.filter(l => l.status === filter);
  tbody.innerHTML = filtered.length ? filtered.map(l => `
    <tr>
      <td>${l.time}</td>
      <td><span class="cond-pill cond-${l.status}">${l.status.replace('_', ' ')}</span></td>
      <td>${l.power}</td><td>${l.current}</td><td>${l.voltage}</td><td>${l.ai}</td>
    </tr>`).join('') :
    `<tr><td colspan="6" style="text-align:center;color:#3d4a60;padding:20px">Belum ada data</td></tr>`;
}

function filterLogs(btn, filter) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderLogs(filter);
}

/* ── BEBAN PAGE ──────────────────────────────────────────── */
let bebanPowerChart = null;
let bebanCurrentChart = null;

/* ── [DIUBAH] initBebanPage — tampilkan nama custom jika ada ─ */
function initBebanPage() {
  const grid = document.getElementById('bebanGrid');
  if (!grid) return;
  grid.innerHTML = BEBAN_LIST.map((b, i) => {
    const pPct = Math.min(100, (b.nominalPower / 500) * 100);
    const aPct = Math.min(100, (b.nominalCurrent / 3) * 100);
    const store = getBebanStore(i);
    const namaCustom = store.namaAlat !== b.name
      ? `<div class="beban-nama-custom">${store.namaAlat}</div>` : '';
    const hasData = store.power.length > 0;
    const dataBadge = hasData
      ? `<span class="beban-data-badge">${store.power.length} data</span>` : '';
    return `
      <div class="beban-card" id="beban-card-${i}" onclick="selectBeban(${i})">
        <span class="beban-type-badge type-${b.type}">${b.typeLabel}</span>
        ${dataBadge}
        <div class="beban-num">BEBAN ${b.id}</div>
        <div class="beban-icon">${b.icon}</div>
        <div class="beban-name">${b.name}</div>
        ${namaCustom}
        <div class="beban-spec">${b.spec}</div>
        <div class="beban-bars">
          <div class="beban-bar-row">
            <span class="beban-bar-label">Daya</span>
            <div class="beban-bar-track"><div class="beban-bar-fill" style="width:${pPct}%;background:${b.color}"></div></div>
            <span class="beban-bar-val">${b.nominalPower}W</span>
          </div>
          <div class="beban-bar-row">
            <span class="beban-bar-label">Arus</span>
            <div class="beban-bar-track"><div class="beban-bar-fill" style="width:${aPct}%;background:${b.color}"></div></div>
            <span class="beban-bar-val">${b.nominalCurrent}A</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ── [DIUBAH] selectBeban — set nama alat, gunakan data isolated ─ */
function selectBeban(idx) {
  document.querySelectorAll('.beban-card').forEach(c => c.classList.remove('active-beban'));
  const card = document.getElementById(`beban-card-${idx}`);
  if (card) card.classList.add('active-beban');
  activeBeban = idx;

  // Tampilkan input nama alat
  showNamaInput(idx);
  showBebanChart(idx);
  showToast(`Silakan masukkan nama alat lalu klik Mulai Pengujian`);
}

function mulaiPengujian() {

  const nama = document
      .getElementById("namaAlatInput")
      .value
      .trim();

  if (!nama) {
      alert("Masukkan nama alat terlebih dahulu!");
      return;
  }

  namaAlatAktif = nama;

  activeAlat = nama;
  testingActive = true;

  const store = getBebanStore(activeBeban);

  store.power = [];
  store.current = [];
  store.voltage = [];
  store.labels = [];
  pengujianAktif = true;

  if (activeBeban !== null) {
      getBebanStore(activeBeban).namaAlat = nama;
  }

  showToast("Pengujian dimulai: " + nama);
}
/* ── [BARU] Input nama alat custom ──────────────────────── */
function showNamaInput(idx) {
  const existing = document.getElementById('namaAlatPanel');
  if (existing) existing.remove();

  const store = getBebanStore(idx);
  const b = BEBAN_LIST[idx];

  const panel = document.createElement('div');
  panel.id = 'namaAlatPanel';
  panel.style.cssText = `
    background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);
    padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;
    gap:12px;flex-wrap:wrap;
  `;
  panel.innerHTML = `
    <span style="font-size:12px;color:var(--text2);font-family:var(--font-mono);">
      Nama alat yang diuji (Beban ${b.id}):
    </span>
    <input id="namaAlatInput" type="text" placeholder="contoh: Kipas Angin Cosmos"
      value="${store.namaAlat}"
      style="flex:1;min-width:180px;padding:7px 12px;background:var(--bg3);
             border:1px solid var(--border2);border-radius:var(--radius-xs);
             color:var(--text0);font-family:var(--font-mono);font-size:13px;
             outline:none;" />
    <button onclick="mulaiPengujian(); simpanNamaAlat(${idx})"
      style="padding:7px 16px;background:var(--accent-dim);border:1px solid var(--accent-glow);
             color:var(--accent);border-radius:var(--radius-xs);font-size:12px;
             font-weight:700;cursor:pointer;white-space:nowrap;">
      Simpan Nama
    </button>
    <button onclick="clearBebanData(${idx})"
      style="padding:7px 12px;background:var(--red-dim);border:1px solid rgba(239,68,68,0.3);
             color:var(--red);border-radius:var(--radius-xs);font-size:12px;
             font-weight:700;cursor:pointer;">
      Reset Data
    </button>`;

  const grid = document.getElementById('bebanGrid');
  grid.parentNode.insertBefore(panel, grid.nextSibling);
}

function simpanNamaAlat(idx) {
  const input = document.getElementById('namaAlatInput');
  if (!input) return;
  const nama = input.value.trim() || BEBAN_LIST[idx].name;
  getBebanStore(idx).namaAlat = nama;
  showToast(`Nama alat disimpan: ${nama}`);
  initBebanPage(); // refresh kartu
  selectBeban(idx); // pilih lagi agar panel tetap terbuka
}

function clearBebanData(idx) {
  const store = getBebanStore(idx);
  store.power = []; store.current = [];
  store.voltage = []; store.labels = [];
  store.status=[]; store.confidence=[];
  store.deltaP=[]; store.cycling=[]; store.cyclePeriod=[];  // BARU
  showToast(`Data Beban ${idx+1} direset`);
  showBebanChart(idx);
  initBebanPage();
}

/* ── [DIUBAH] showBebanChart — baca dari bebanStore[idx] ─── */
function showBebanChart(idx) {
  const b = BEBAN_LIST[idx];
  const panel = document.getElementById('bebanChartPanel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const store = getBebanStore(idx);
  const namaLabel = store.namaAlat !== b.name ? ` (${store.namaAlat})` : '';
  document.getElementById('bebanChartTitle').textContent =
    `Beban ${b.id} — ${b.name}${namaLabel} · Data Pengujian`;

  // Ambil data dari store beban ini — BUKAN dari stores global
  const pwrData  = [...store.power];
  const currData = [...store.current];
  const labels   = [...store.labels];

  if (bebanPowerChart) bebanPowerChart.destroy();
  const pCtx = document.getElementById('bebanPowerChart').getContext('2d');
  bebanPowerChart = new Chart(pCtx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Daya (W)', ...chartDefaults(b.color), data: pwrData }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        title: { display: true, text: 'Daya (W)', color: '#94a3b8', font: { size: 11 } } },
      scales: {
        x: { ticks: { color: '#3d4a60' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } }
      }
    }
  });

  if (bebanCurrentChart) bebanCurrentChart.destroy();
  const cCtx = document.getElementById('bebanCurrentChart').getContext('2d');
  bebanCurrentChart = new Chart(cCtx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Arus (A)', ...chartDefaults('#3b82f6'), data: currData }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        title: { display: true, text: 'Arus (A)', color: '#94a3b8', font: { size: 11 } } },
      scales: {
        x: { ticks: { color: '#3d4a60' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } }
      }
    }
  });

  // Stats dari data beban ini saja
  const avgP = pwrData.length ? (pwrData.reduce((a,v)=>a+v,0)/pwrData.length).toFixed(1) : 0;
  const maxP = pwrData.length ? Math.max(...pwrData).toFixed(1) : 0;
  const minP = pwrData.length ? Math.min(...pwrData).toFixed(1) : 0;
  const avgA = currData.length ? (currData.reduce((a,v)=>a+v,0)/currData.length).toFixed(3) : 0;

  document.getElementById('bebanStats').innerHTML = `
    <div class="bstat"><div class="bstat-label">Nama Alat</div><div class="bstat-val">${store.namaAlat}</div></div>
    <div class="bstat"><div class="bstat-label">Daya Rata-rata</div><div class="bstat-val">${avgP} W</div></div>
    <div class="bstat"><div class="bstat-label">Daya Maks</div><div class="bstat-val">${maxP} W</div></div>
    <div class="bstat"><div class="bstat-label">Daya Min</div><div class="bstat-val">${minP} W</div></div>
    <div class="bstat"><div class="bstat-label">Arus Rata-rata</div><div class="bstat-val">${avgA} A</div></div>
    <div class="bstat"><div class="bstat-label">Jumlah Data</div><div class="bstat-val">${pwrData.length} titik</div></div>
    <div class="bstat"><div class="bstat-label">Tipe Beban</div><div class="bstat-val">${b.typeLabel}</div></div>
    <div class="bstat"><div class="bstat-label">Kondisi</div><div class="bstat-val">${classifyStatus(+avgP, +avgA, 220)}</div></div>`;
}

/* ── [DIUBAH] updateBebanRealtime — update chart dari bebanStore ─ */
function updateBebanRealtime() {

  if (!bebanPowerChart || !bebanCurrentChart) return;

  if (activeBeban === null) return;

  const store = getBebanStore(activeBeban);

  const b = BEBAN_LIST[activeBeban];

  /* update chart */
  bebanPowerChart.data.labels = [...store.labels];
  bebanPowerChart.data.datasets[0].data = [...store.power];
  bebanPowerChart.update('none');

  bebanCurrentChart.data.labels = [...store.labels];
  bebanCurrentChart.data.datasets[0].data = [...store.current];
  bebanCurrentChart.update('none');

  /* update statistik realtime */
  const pwrData  = store.power;
  const currData = store.current;

  const avgP = pwrData.length
    ? (pwrData.reduce((a,v)=>a+v,0)/pwrData.length).toFixed(1)
    : 0;

  const maxP = pwrData.length
    ? Math.max(...pwrData).toFixed(1)
    : 0;

  const minP = pwrData.length
    ? Math.min(...pwrData).toFixed(1)
    : 0;

  const avgA = currData.length
    ? (currData.reduce((a,v)=>a+v,0)/currData.length).toFixed(3)
    : 0;

  document.getElementById('bebanStats').innerHTML = `
    <div class="bstat"><div class="bstat-label">Nama Alat</div><div class="bstat-val">${store.namaAlat}</div></div>
    <div class="bstat"><div class="bstat-label">Daya Rata-rata</div><div class="bstat-val">${avgP} W</div></div>
    <div class="bstat"><div class="bstat-label">Daya Maks</div><div class="bstat-val">${maxP} W</div></div>
    <div class="bstat"><div class="bstat-label">Daya Min</div><div class="bstat-val">${minP} W</div></div>
    <div class="bstat"><div class="bstat-label">Arus Rata-rata</div><div class="bstat-val">${avgA} A</div></div>
    <div class="bstat"><div class="bstat-label">Jumlah Data</div><div class="bstat-val">${pwrData.length} titik</div></div>
    <div class="bstat"><div class="bstat-label">Tipe Beban</div><div class="bstat-val">${b.typeLabel}</div></div>
    <div class="bstat"><div class="bstat-label">Kondisi</div><div class="bstat-val">${classifyStatus(+avgP, +avgA, 220)}</div></div>
  `;
}

async function closeBebanChart(){

    await selesaiPengujian();

    document.getElementById('bebanChartPanel').style.display='none';

    document
        .querySelectorAll('.beban-card')
        .forEach(c => c.classList.remove('active-beban'));

    const namaPanel =
        document.getElementById('namaAlatPanel');

    if (namaPanel)
        namaPanel.remove();

    showToast("Pengujian beban dihentikan");

}

/* ── MODAL ───────────────────────────────────────────────── */
let modalChart = null;

function openModal(param) {
  const s = stores[param];
  if (!s) return;
  document.getElementById('modalTitle').textContent = s.name;
  document.getElementById('modalBigVal').textContent = s.data.length ? s.data[s.data.length - 1] : '—';
  document.getElementById('modalBigUnit').textContent = s.unit;
  if (s.data.length > 0) {
    const mn = Math.min(...s.data);
    const mx = Math.max(...s.data);
    const avg = (s.data.reduce((a, b) => a + b, 0) / s.data.length).toFixed(2);
    document.getElementById('modalMin').textContent = mn.toFixed(2);
    document.getElementById('modalMax').textContent = mx.toFixed(2);
    document.getElementById('modalAvg').textContent = avg;
    document.getElementById('modalLast').textContent = s.data[s.data.length - 1];
  }
  if (modalChart) modalChart.destroy();
  const ctx = document.getElementById('modalChart').getContext('2d');
  modalChart = new Chart(ctx, {
    type: 'line',
    data: { labels: s.labels, datasets: [{ label: s.name, ...chartDefaults(spkColors[param] || '#00d4aa'), data: [...s.data] }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { ticks: { color: '#3d4a60', maxTicksLimit: 8, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', maxTicksLimit: 5 } }
      }
    }
  });
  const tbody = document.getElementById('modalTableBody');
  const last30 = s.data.slice(-30).reverse();
  const last30L = s.labels.slice(-30).reverse();
  tbody.innerHTML = last30.map((v, i) => `<tr><td>${last30L[i]}</td><td>${v} ${s.unit}</td></tr>`).join('');
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  if (modalChart) { modalChart.destroy(); modalChart = null; }
}

/* ── PAGE NAVIGATION ─────────────────────────────────────── */
const pageTitles = { dashboard: 'Dashboard', beban: 'Pengujian Beban', history: 'Riwayat Kejadian', settings: 'Pengaturan' };

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  const navEl = document.querySelector(`[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');
  document.getElementById('pageTitle').textContent = pageTitles[page] || page;
  if (page === 'history') renderLogs(currentFilter);
  if (page === 'beban') initBebanPage();
  if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
}

function setChartRange(btn, range) {
  document.querySelectorAll('.toggle-group .tgl').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function saveSettings() {
  console.log("TOMBOL SIMPAN DIKLIK");
  BASE_URL = document.getElementById('cfgUrl').value;
  POLL_INTERVAL = parseInt(document.getElementById('cfgInterval').value) * 1000;

  CFG.warnPower  = parseInt(document.getElementById('cfgWarn').value);
  CFG.highPower  = parseInt(document.getElementById('cfgHigh').value);
  CFG.shortPower = parseInt(document.getElementById('cfgShort').value);

  clearInterval(pollTimer);
  

  try {

    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        warnPower: CFG.warnPower,
        highPower: CFG.highPower,
        shortPower: CFG.shortPower
      })
    });

    const result = await res.json();

    console.log("SETTINGS SAVED:", result);

    showToast("Pengaturan tersimpan ke server");

  } catch(err) {

    console.error(err);

    showToast("Gagal simpan ke server");

  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

/* ── MAIN LOOP ───────────────────────────────────────────── */
async function tick() {

    if (isTicking) {
        console.log("Tick dilewati");
        return;
    }

    isTicking = true;

    try {

        const data = await fetchLatest();

        cekStatus(data);

        console.log("RELAY:", data.relay);

        recordToActiveBeban(data);

        render(data);

        addLog(data);

        renderLogs(currentFilter);

        if (charts.hist) {

            const now = new Date().toLocaleTimeString(
                'id-ID',
                { hour12:false }
            );

            if (charts.hist.data.labels.length >= 48) {

                charts.hist.data.labels.shift();
                charts.hist.data.datasets[0].data.shift();
                charts.hist.data.datasets[1].data.shift();

            }

            charts.hist.data.labels.push(now);

            charts.hist.data.datasets[0].data.push(data.power);

            charts.hist.data.datasets[1].data.push(data.current * 100);

            charts.hist.update('none');

        }

        if (activeBeban !== null) {
            updateBebanRealtime();
        }

    }
    catch(err){

        console.error(err);

    }
    finally{

        isTicking = false;

    }

}

/* ── SIDEBAR ─────────────────────────────────────────────── */
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const mobMenu = document.getElementById('mobMenu');
  const sidebarToggle = document.getElementById('sidebarToggle');
  if (mobMenu && sidebar) mobMenu.addEventListener('click', () => sidebar.classList.toggle('open'));
  if (sidebarToggle && sidebar) sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
  });
}

function seedDemoLogs() {
  const now = new Date();
  const demoLogs = [
    { status: 'WARNING', power: 1250, current: 5.68, voltage: 220.1, ai: 'WASPADA' },
    { status: 'HIGH_CONSUMPTION', power: 2100, current: 9.55, voltage: 219.8, ai: 'WASPADA' },
    { status: 'WARNING', power: 1050, current: 4.77, voltage: 220.3, ai: 'WASPADA' },
  ];
  demoLogs.forEach((l, i) => {
    const t = new Date(now.getTime() - (i + 1) * 300000);
    logEntries.push({ ...l, time: t.toLocaleString('id-ID') });
  });
}

fetch(`${BASE_URL}/api/latest`)
  .then(res => res.json())
  .then(data => console.log("API CONNECT:", data))
  .catch(err => console.log("API ERROR:", err));

function downloadCSV(namaAlat, data) {

    if (!data.length) {
        showToast("Tidak ada data");
        return;
    }

    const avgPower =
        (data.reduce((a,b)=>a+b.power,0)/data.length).toFixed(2);

    const avgCurrent =
        (data.reduce((a,b)=>a+b.current,0)/data.length).toFixed(3);

    const avgVoltage =
        (data.reduce((a,b)=>a+b.voltage,0)/data.length).toFixed(2);

    const maxPower =
        Math.max(...data.map(d=>d.power)).toFixed(2);

    const minPower =
        Math.min(...data.map(d=>d.power)).toFixed(2);

    let csv = "";

    csv += "HASIL PENGUJIAN BEBAN\n\n";

    csv += `Nama Alat,${namaAlat}\n`;
    csv += `Tanggal,${new Date().toLocaleDateString("id-ID")}\n`;
    csv += `Jam,${new Date().toLocaleTimeString("id-ID")}\n\n`;

    csv += `Jumlah Data,${data.length}\n`;
    csv += `Daya Rata-rata (W),${avgPower}\n`;
    csv += `Daya Maksimum (W),${maxPower}\n`;
    csv += `Daya Minimum (W),${minPower}\n`;
    csv += `Arus Rata-rata (A),${avgCurrent}\n`;
    csv += `Tegangan Rata-rata (V),${avgVoltage}\n\n`;

    csv += "DATA PENGUJIAN\n\n";

    csv += "No,Waktu,Tegangan(V),Arus(A),Daya(W),Status,Confidence\n";

    
    const blob = new Blob([csv],{
        type:"text/csv;charset=utf-8;"
    });

    const link=document.createElement("a");

    link.href=URL.createObjectURL(blob);

    link.download=
        namaAlat.replace(/\s+/g,"_")+
        "_"+
        new Date().toISOString().slice(0,19).replace(/:/g,"-")+
        ".csv";

    link.click();

    URL.revokeObjectURL(link.href);

}

async function selesaiPengujian() {

    if (activeBeban === null) {
        showToast("Tidak ada beban yang sedang diuji");
        return;
    }

    const store = getBebanStore(activeBeban);

    const hasil = [];

    for (let i = 0; i < store.power.length; i++) {

        hasil.push({
        waktu: store.labels[i],
        voltage: store.voltage[i],
        current: store.current[i],
        power: store.power[i],

        status: store.status[i],
        confidence: store.confidence[i],

        deltaP: store.deltaP[i],             // BARU
        cycling: store.cycling[i],           // BARU
        cyclePeriod: store.cyclePeriod[i]    // BARU
    });
    }

    console.log("DATA =", hasil);

    try {

        // ==========================
        // Simpan ke server
        // ==========================
        const res = await fetch(`${BASE_URL}/api/save-pengujian`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                namaAlat: store.namaAlat,
                data: hasil
            })
        });

        const result = await res.json();

        console.log(result);

        if (!result.success) {
            throw new Error(result.error || "Gagal menyimpan ke server");
        }

        // ==========================
        // Download Excel
        // ==========================
        downloadExcel(store.namaAlat, hasil);

        // ==========================
        // Download PDF
        // ==========================
        await downloadPDF(store.namaAlat, hasil);

        // ==========================
        // Reset data setelah berhasil
        // ==========================
        store.power = [];
        store.current = [];
        store.voltage = [];
        store.labels = [];
        store.status = [];
        store.confidence = [];
        store.deltaP = [];        // BARU
        store.cycling = [];       // BARU
        store.cyclePeriod = [];  

        pengujianAktif = false;
        testingActive = false;
        activeBeban = null;

        showToast("Pengujian berhasil disimpan");

    }
    catch (err) {

        console.error(err);

        showToast("Gagal menyimpan: " + err.message);

    }

}

function downloadExcel(namaAlat, data){

    if(data.length===0){
        showToast("Tidak ada data");
        return;
    }

    const avgPower =
        (data.reduce((a,b)=>a+b.power,0)/data.length).toFixed(2);

    const avgCurrent =
        (data.reduce((a,b)=>a+b.current,0)/data.length).toFixed(3);

    const avgVoltage =
        (data.reduce((a,b)=>a+b.voltage,0)/data.length).toFixed(2);

    const maxPower =
        Math.max(...data.map(d=>d.power)).toFixed(2);

    const minPower =
        Math.min(...data.map(d=>d.power)).toFixed(2);

    const wsData = [

        ["HASIL PENGUJIAN BEBAN"],

        [],

        ["Nama Alat", namaAlat],
        ["Tanggal", new Date().toLocaleDateString("id-ID")],
        ["Jam", new Date().toLocaleTimeString("id-ID")],

        [],

        ["Jumlah Data", data.length],
        ["Daya Rata-rata (W)", avgPower],
        ["Daya Maksimum (W)", maxPower],
        ["Daya Minimum (W)", minPower],
        ["Arus Rata-rata (A)", avgCurrent],
        ["Tegangan Rata-rata (V)", avgVoltage],

        [],

        ["No","Waktu","Volt","Arus","Daya","Status","Confidence"]

    ];

    data.forEach((d,i)=>{

    wsData.push([
      i+1,
      d.waktu,
      Number(d.voltage).toFixed(1),
      Number(d.current).toFixed(3),
      Number(d.power).toFixed(2),
      d.status,
      Number(d.confidence || 0).toFixed(2)
  ]);

});
const wb = XLSX.utils.book_new();

const ws = XLSX.utils.aoa_to_sheet(wsData);

XLSX.utils.book_append_sheet(
    wb,
    ws,
    "Pengujian"
);
XLSX.writeFile(
    wb,
    namaAlat.replace(/\s+/g, "_") +
    "_" +
    new Date().toISOString().slice(0,19).replace(/:/g,"-") +
    ".xlsx"
);

}
// ======================================
// MEMBUAT GRAFIK UNTUK PDF
// ======================================
function createChartImage(data, field, label, color){

    return new Promise(resolve=>{

        const canvas = document.createElement("canvas");

        canvas.width = 1200;
        canvas.height = 500;

        const ctx = canvas.getContext("2d");

        new Chart(ctx,{
            type:"line",
            data:{
                labels:data.map((d,i)=>i+1),
                datasets:[{
                    label:label,
                    data:data.map(d=>Number(d[field])),
                    borderColor:color,
                    backgroundColor:color+"33",
                    fill:true,
                    tension:0.35,
                    pointRadius:0
                }]
            },
            options:{
                responsive:false,
                animation:false,
                plugins:{
                    legend:{
                        display:true
                    }
                },
                scales:{
                    x:{
                        title:{
                            display:true,
                            text:"Sampling"
                        }
                    },
                    y:{
                        title:{
                            display:true,
                            text:label
                        }
                    }
                }
            }
        });

        setTimeout(()=>{

            resolve(canvas.toDataURL("image/png"));

        },500);

    });

}
async function downloadPDF(namaAlat, data){

    if(data.length===0){
        showToast("Tidak ada data");
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF("p","mm","a4");

    //=====================================================
    // DESAIN / KONSTANTA WARNA & LAYOUT
    //=====================================================
    const COLOR = {
        primaryDark: [10, 48, 92],
        primary:     [15, 76, 129],
        primaryLite: [35, 110, 168],
        gold:        [212, 168, 83],
        accent:      [255, 122, 26],
        blueChart:   [0, 122, 255],
        text:        [40, 40, 40],
        textMuted:   [110, 118, 128],
        line:        [220, 224, 229],
        cardBg:      [246, 248, 251],
        cardBorder:  [225, 230, 236],
        badgeNormalBg:  [222, 247, 236], badgeNormalText:  [15, 122, 79],
        badgeWarningBg: [255, 244, 214], badgeWarningText: [153, 105, 4],
        badgeHighBg:    [255, 231, 214], badgeHighText:    [176, 71, 0],
        badgeDangerBg:  [255, 224, 224], badgeDangerText:  [180, 30, 30],
    };

    const pageWidth  = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 15;
    const contentWidth = pageWidth - margin*2;
    let y = 20;

    //---- helper: gradasi horizontal (simulasi gradient jsPDF) ----
    function gradientRect(x, yPos, w, h, colorStart, colorEnd, steps = 60) {
        const stepW = w / steps;
        for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1);
            const r = colorStart[0] + (colorEnd[0]-colorStart[0])*t;
            const g = colorStart[1] + (colorEnd[1]-colorStart[1])*t;
            const b = colorStart[2] + (colorEnd[2]-colorStart[2])*t;
            doc.setFillColor(r,g,b);
            doc.rect(x + stepW*i, yPos, stepW + 0.6, h, "F");
        }
    }

    function sectionTitle(title, yPos) {
        doc.setFillColor(...COLOR.primary);
        doc.rect(margin, yPos - 4.5, 1.2, 6, "F");
        doc.setFont("helvetica","bold");
        doc.setFontSize(12.5);
        doc.setTextColor(...COLOR.primary);
        doc.text(title, margin + 4, yPos);
        doc.setTextColor(...COLOR.text);
        return yPos + 8;
    }

    function infoRow(label, value, yPos, xLabel = margin, xColon = xLabel + 45, xValue = xLabel + 48) {
        doc.setFont("helvetica","normal");
        doc.setFontSize(10.5);
        doc.setTextColor(...COLOR.textMuted);
        doc.text(label, xLabel, yPos);
        doc.text(":", xColon, yPos);
        doc.setTextColor(...COLOR.text);
        doc.setFont("helvetica","bold");
        doc.text(String(value), xValue, yPos);
        return yPos + 6.2;
    }

    function statusBadge(status, xPos, yPos) {
        let bg = COLOR.badgeNormalBg, tx = COLOR.badgeNormalText, label = status;
        if (status.includes("WARNING")) { bg = COLOR.badgeWarningBg; tx = COLOR.badgeWarningText; }
        else if (status.includes("HIGH")) { bg = COLOR.badgeHighBg; tx = COLOR.badgeHighText; }
        else if (status.includes("SHORT")) { bg = COLOR.badgeDangerBg; tx = COLOR.badgeDangerText; }
        const w = doc.getTextWidth(label) + 8;
        doc.setFillColor(...bg);
        doc.roundedRect(xPos, yPos - 4.6, w, 6.5, 1.5, 1.5, "F");
        doc.setFont("helvetica","bold");
        doc.setFontSize(9.5);
        doc.setTextColor(...tx);
        doc.text(label, xPos + 4, yPos);
        doc.setTextColor(...COLOR.text);
        return w;
    }

    function booleanBadge(isTrue, trueLabel, falseLabel, xPos, yPos) {
        const bg = isTrue ? COLOR.badgeWarningBg : COLOR.badgeNormalBg;
        const tx = isTrue ? COLOR.badgeWarningText : COLOR.badgeNormalText;
        const label = isTrue ? trueLabel : falseLabel;
        const w = doc.getTextWidth(label) + 8;
        doc.setFillColor(...bg);
        doc.roundedRect(xPos, yPos - 4.6, w, 6.5, 1.5, 1.5, "F");
        doc.setFont("helvetica","bold");
        doc.setFontSize(9.5);
        doc.setTextColor(...tx);
        doc.text(label, xPos + 4, yPos);
        doc.setFont("helvetica","normal");   // BARU — reset font
        doc.setFontSize(10.5);               // BARU — reset ukuran
        doc.setTextColor(...COLOR.text);
    }

    function footerAndPageNum() {
        const totalPage = doc.internal.getNumberOfPages();
        for (let i = 1; i <= totalPage; i++) {
            doc.setPage(i);
            doc.setDrawColor(...COLOR.line);
            doc.line(15, pageHeight - 12, pageWidth - 15, pageHeight - 12);
            doc.setFontSize(8);
            doc.setFont("helvetica","normal");
            doc.setTextColor(...COLOR.textMuted);
            doc.text("Kupit Smart IoT Energy Monitor", 15, pageHeight - 7);
            doc.text("Sistem Monitoring Energi Listrik Berbasis IoT", pageWidth/2, pageHeight - 7, { align:"center" });
            doc.text("Halaman " + i + " dari " + totalPage, pageWidth - 15, pageHeight - 7, { align:"right" });
        }
    }

    function mostFrequent(arr) {
        const filtered = arr.filter(v => v !== null && v !== undefined);
        if (!filtered.length) return null;
        const counts = {};
        filtered.forEach(v => counts[v] = (counts[v]||0) + 1);
        return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
    }

    //-----------------------------
    // AMBIL GRAFIK
    //-----------------------------
    const powerChart = await createChartImage(data, "power", "Power (W)", "#ff6b00");
    const currentChart = await createChartImage(data, "current", "Current (A)", "#0080ff");

    const logo = document.getElementById("logoUniversitas");

    //-----------------------------
    // HITUNG STATISTIK
    //-----------------------------
    const avgPower = data.reduce((a,b)=>a+b.power,0)/data.length;
    const avgCurrent = data.reduce((a,b)=>a+b.current,0)/data.length;
    const avgVoltage = data.reduce((a,b)=>a+b.voltage,0)/data.length;
    const maxPower = Math.max(...data.map(d=>d.power));
    const minPower = Math.min(...data.map(d=>d.power));

    const normal = data.filter(d=>d.status==="NORMAL").length;
    const warning = data.filter(d=>d.status==="WARNING").length;
    const high = data.filter(d=>d.status==="HIGH_CONSUMPTION").length;
    const shortCircuit = data.filter(d=>d.status==="SHORT_CIRCUIT").length;
    const normalCount = normal, warningCount = warning, highCount = high, shortCount = shortCircuit;

    const total = data.length;
    const pNormal  = ((normalCount/total)*100).toFixed(1);
    const pWarning = ((warningCount/total)*100).toFixed(1);
    const pHigh    = ((highCount/total)*100).toFixed(1);
    const pShort   = ((shortCount/total)*100).toFixed(1);

    const confidenceList = data.map(d => Number(d.confidence) || 0);
    const avgConfidence = confidenceList.reduce((a,b)=>a+b,0) / confidenceList.length;
    const maxConfidence = Math.max(...confidenceList);
    const minConfidence = Math.min(...confidenceList);

    //------------------------------------------------
    // RULE BASED ANALYSIS
    //------------------------------------------------
    let finalStatus = "NORMAL";
    if (shortCount > 0) finalStatus = "SHORT CIRCUIT";
    else if (highCount > 0) finalStatus = "HIGH CONSUMPTION";
    else if (warningCount > 0) finalStatus = "WARNING";
    const confidence = avgConfidence.toFixed(2) + "%";

    //------------------------------------------------
    // TEMPORAL PATTERN ANALYSIS
    //------------------------------------------------
    let deltaPArr = [];
    for (let i = 1; i < data.length; i++) {
        deltaPArr.push(Number(data[i].power) - Number(data[i-1].power));
    }
    const maxDelta = deltaPArr.length>0 ? Math.max(...deltaPArr).toFixed(2) : 0;
    const minDelta = deltaPArr.length>0 ? Math.min(...deltaPArr).toFixed(2) : 0;
    const maxAbsDelta = deltaPArr.length>0 ? Math.max(...deltaPArr.map(v=>Math.abs(v))).toFixed(2) : 0;

    //------------------------------------------------
    // ANALISIS LANJUTAN — FLUKTUASI & DEVICE CYCLING (BARU, dari data real)
    //------------------------------------------------
    const deltaPStoredArr = data.map(d => Number(d.deltaP || 0));
    const abnormalFlukArr = deltaPStoredArr.filter(dp => Math.abs(dp) > CFG.tfluk);
    const abnormalFlukCount = abnormalFlukArr.length;
    const pFluk = total > 0 ? ((abnormalFlukCount/total)*100).toFixed(1) : "0.0";

    const cyclingArr = data.map(d => !!d.cycling);
    const cyclingCount = cyclingArr.filter(c => c).length;
    const cyclingDetected = cyclingCount > 0;

    let onOffTransitions = 0;
    for (let i = 1; i < cyclingArr.length; i++) {
        if (cyclingArr[i] && !cyclingArr[i-1]) onOffTransitions++;
    }

    const cyclePeriodArr = data.map(d => d.cyclePeriod).filter(p => p !== null && p !== undefined);
    const cyclePeriodMode = mostFrequent(cyclePeriodArr);

    let keputusan = "";
    if (finalStatus === "NORMAL") keputusan = "Tidak ditemukan anomali konsumsi daya listrik.";
    else if (finalStatus === "WARNING") keputusan = "Terdapat kenaikan konsumsi daya. Disarankan melakukan pemantauan.";
    else if (finalStatus === "HIGH CONSUMPTION") keputusan = "Beban termasuk kategori konsumsi daya tinggi.";
    else keputusan = "Terindikasi SHORT CIRCUIT. Segera matikan sumber listrik.";

    //------------------------------------------------
    // NARASI DINAMIS — dihitung ulang dari data real, bukan teks statis
    //------------------------------------------------
    function buildNarasiRealtime() {
        const bagian = [];

        bagian.push(`Dari total ${total} data pengujian pada alat "${namaAlat}", sistem mencatat ${pNormal}% kondisi Normal, ${pWarning}% Warning, ${pHigh}% High Consumption, dan ${pShort}% Short Circuit, dengan status akhir sistem berada pada kategori ${finalStatus}.`);

        if (cyclingDetected) {
            bagian.push(`Pola device cycling terdeteksi pada ${cyclingCount} dari ${total} data (${((cyclingCount/total)*100).toFixed(1)}%) dengan ${onOffTransitions} kali transisi ON-OFF${cyclePeriodMode ? `, dan estimasi periode siklus sekitar ${cyclePeriodMode} detik` : ''}. Pola ini mengindikasikan beban bekerja secara termostatik/periodik, sesuai karakteristik perangkat yang menyala-mati otomatis.`);
        } else {
            bagian.push(`Tidak terdeteksi pola device cycling yang signifikan selama pengujian, mengindikasikan beban bersifat kontinu atau stabil tanpa siklus ON-OFF otomatis.`);
        }

        if (abnormalFlukCount > 0) {
            bagian.push(`Fluktuasi daya abnormal (dP melebihi ambang ${CFG.tfluk} W) terjadi sebanyak ${abnormalFlukCount} kali (${pFluk}% dari total data), dengan perubahan daya terbesar mencapai ${maxAbsDelta} Watt. Kondisi ini perlu menjadi perhatian dalam evaluasi kestabilan beban.`);
        } else {
            bagian.push(`Tidak ditemukan fluktuasi daya abnormal (dP > ${CFG.tfluk} W) selama proses pengujian, menunjukkan kestabilan konsumsi daya yang baik.`);
        }
        const kualitas = avgConfidence >= 80 ? "tinggi" : avgConfidence >= 60 ? "cukup baik" : "perlu ditingkatkan";
        bagian.push(`Nilai confidence rata-rata sistem tercatat sebesar ${avgConfidence.toFixed(2)}% (rentang ${minConfidence.toFixed(2)}% – ${maxConfidence.toFixed(2)}%), menunjukkan tingkat keandalan deteksi yang ${kualitas}.`);

        return bagian.join(" ");
    }

    const narasiRealtime = buildNarasiRealtime();

    //=====================================================
    // HALAMAN 1 — COVER / HEADER (LEBIH GAGAH)
    //=====================================================
    // Gradasi navy tua -> navy terang sebagai background header
    gradientRect(0, 0, pageWidth, 44, COLOR.primaryDark, COLOR.primaryLite);

    // Garis aksen emas tipis di bawah header
    doc.setFillColor(...COLOR.gold);
    doc.rect(0, 44, pageWidth, 1.6, "F");

    // Kotak putih di belakang logo supaya logo menonjol
    if (logo) {
        doc.setFillColor(255,255,255);
        doc.roundedRect(margin - 2, 7, 26, 26, 2, 2, "F");
        doc.addImage(logo.src, "PNG", margin + 1, 10, 20, 20);
    }

    doc.setFont("helvetica","bold");
    doc.setFontSize(19);
    doc.setTextColor(255,255,255);
    doc.text("HASIL PENGUJIAN SISTEM IoT", pageWidth/2 + 10, 17, { align:"center" });

    doc.setFont("helvetica","normal");
    doc.setFontSize(11);
    doc.setTextColor(225,235,245);
    doc.text("Deteksi Anomali Konsumsi Daya Listrik Berbasis Rule-Based & Pattern Analysis", pageWidth/2 + 10, 25, { align:"center" });

    // Badge kecil kanan atas: tanggal terbit
    const tanggalStr = new Date().toLocaleDateString("id-ID", { day:"2-digit", month:"long", year:"numeric" });
    doc.setFontSize(8.5);
    doc.setTextColor(210, 222, 235);
    doc.text(tanggalStr, pageWidth/2 + 10, 32, { align:"center" });

    // Garis pemisah dekoratif kecil
    doc.setDrawColor(...COLOR.gold);
    doc.setLineWidth(0.6);
    doc.line(pageWidth/2 + 10 - 30, 35, pageWidth/2 + 10 + 30, 35);
    doc.setLineWidth(0.2);

    doc.setTextColor(...COLOR.text);
    y = 55;

    //---------------------------------
    // IDENTITAS MAHASISWA
    //---------------------------------
    doc.setFillColor(...COLOR.cardBg);
    doc.setDrawColor(...COLOR.cardBorder);
    doc.roundedRect(margin, y - 6, contentWidth, 44, 2.5, 2.5, "FD");

    y = sectionTitle("IDENTITAS MAHASISWA", y);
    y = infoRow("Nama Mahasiswa", "Muhammad Arif Hidayatulloh", y);
    y = infoRow("NIM", "231301007", y);
    y = infoRow("Program Studi", "Sistem Komputer", y);
    y = infoRow("Universitas", "Universitas Nahdlatul Ulama Sunan Giri", y);
    y = infoRow("Lokasi Pengujian", "Laboratorium Kupit_3D IoT", y);

    y += 8;

    //---------------------------------
    // INFORMASI PENGUJIAN
    //---------------------------------
    doc.setFillColor(...COLOR.cardBg);
    doc.setDrawColor(...COLOR.cardBorder);
    doc.roundedRect(margin, y - 6, contentWidth, 26, 2.5, 2.5, "FD");

    y = sectionTitle("INFORMASI PENGUJIAN", y);
    y = infoRow("Nama Alat", namaAlat, y);
    y = infoRow("Tanggal", new Date().toLocaleDateString("id-ID"), y);
    y = infoRow("Jam", new Date().toLocaleTimeString("id-ID"), y);

    y += 8;

    //-----------------------------
    // STATISTIK PENGUJIAN
    //-----------------------------
    doc.setFillColor(...COLOR.cardBg);
    doc.setDrawColor(...COLOR.cardBorder);
    doc.roundedRect(margin, y - 6, contentWidth, 44, 2.5, 2.5, "FD");

    y = sectionTitle("STATISTIK PENGUJIAN", y);
    y = infoRow("Jumlah Data", data.length, y);
    y = infoRow("Daya Rata-rata", avgPower.toFixed(2) + " Watt", y);
    y = infoRow("Daya Maksimum", maxPower.toFixed(2) + " Watt", y);
    y = infoRow("Daya Minimum", minPower.toFixed(2) + " Watt", y);
    y = infoRow("Arus Rata-rata", avgCurrent.toFixed(3) + " Ampere", y);
    y = infoRow("Tegangan Rata-rata", avgVoltage.toFixed(2) + " Volt", y);

    y += 8;
    if (y > 200) { doc.addPage(); y = 20; }

    //--------------------------------------
    // HASIL ANALISIS SISTEM DETEKSI
    //--------------------------------------
    doc.setFillColor(...COLOR.cardBg);
    doc.setDrawColor(...COLOR.cardBorder);
    doc.roundedRect(margin, y - 6, contentWidth, 46, 2.5, 2.5, "FD");

    y = sectionTitle("HASIL ANALISIS SISTEM DETEKSI", y);

    doc.setFont("helvetica","normal");
    doc.setFontSize(10.5);
    doc.setTextColor(...COLOR.textMuted);
    doc.text("Status Sistem", margin, y);
    doc.text(":", margin + 45, y);
    statusBadge(finalStatus, margin + 48, y);
    y += 6.2;

    y = infoRow("Confidence Level", confidence, y);
    y = infoRow("Normal", normalCount, y);
    y = infoRow("Warning", warningCount, y);
    y = infoRow("High Consumption", highCount, y);
    y = infoRow("Short Circuit", shortCount, y);

    y += 8;
    if (y > 200) { doc.addPage(); y = 20; }

    //--------------------------------------
    // ANALISIS DETEKSI LANJUTAN — BARU
    // (Rule-Based Status, ΔP Temporal, Fluktuasi Abnormal,
    //  Device Cycling, Siklus ON-OFF, Periode Siklus)
    //--------------------------------------
    doc.setFillColor(...COLOR.cardBg);
    doc.setDrawColor(...COLOR.cardBorder);
    doc.roundedRect(margin, y - 6, contentWidth, 58, 2.5, 2.5, "FD");

    y = sectionTitle("ANALISIS DETEKSI LANJUTAN (REAL-TIME PATTERN)", y);

    doc.setFont("helvetica","normal");
    doc.setFontSize(10.5);
    doc.setTextColor(...COLOR.textMuted);
    doc.text("Rule-Based Status", margin, y);
    doc.text(":", margin + 45, y);
    statusBadge(finalStatus, margin + 48, y);
    y += 6.2;

    y = infoRow("dP Maks / Min", `${maxDelta} W  /  ${minDelta} W`, y);
    y = infoRow("dP Terbesar", maxAbsDelta + " W", y);

    // reset font sebelum baris badge, supaya tidak kebawa bold dari fungsi sebelumnya
    doc.setFont("helvetica","normal");
    doc.setFontSize(10.5);
    doc.setTextColor(...COLOR.textMuted);
    doc.text("Fluktuasi Abnormal", margin, y);
    doc.text(":", margin + 45, y);
    booleanBadge(abnormalFlukCount > 0, `Ya, ${abnormalFlukCount}x (${pFluk}%)`, "Tidak ada", margin + 48, y);
    y += 6.2;

    // reset lagi — WAJIB, karena booleanBadge() di atas mengubah font jadi bold
    doc.setFont("helvetica","normal");
    doc.setFontSize(10.5);
    doc.setTextColor(...COLOR.textMuted);
    doc.text("Device Cycling", margin, y);
    doc.text(":", margin + 45, y);
    booleanBadge(cyclingDetected, `Terdeteksi (${cyclingCount} data)`, "Tidak ada", margin + 48, y);
    y += 6.2;

    y = infoRow("Siklus ON-OFF", onOffTransitions + " kali", y);
    y = infoRow("Periode Siklus", cyclePeriodMode ? cyclePeriodMode + " detik" : "Tidak terdeteksi", y);

    y += 8;
    if (y > 190) { doc.addPage(); y = 20; }

    //--------------------------------------
    // KEPUTUSAN SISTEM
    //--------------------------------------
    const keputusanLines = doc.splitTextToSize(keputusan, contentWidth - 8);
    const keputusanBoxH = keputusanLines.length * 5.5 + 14;

    doc.setFillColor(...COLOR.badgeWarningBg);
    doc.setDrawColor(...COLOR.accent);
    doc.roundedRect(margin, y - 6, contentWidth, keputusanBoxH, 2.5, 2.5, "FD");

    doc.setFont("helvetica","bold");
    doc.setFontSize(11);
    doc.setTextColor(...COLOR.accent);
    doc.text("KEPUTUSAN SISTEM", margin + 4, y);
    y += 7;

    doc.setFont("helvetica","normal");
    doc.setFontSize(10.5);
    doc.setTextColor(...COLOR.text);
    doc.text(keputusanLines, margin + 4, y);
    y += keputusanLines.length * 5.5 + 10;

    if (y > 180) { doc.addPage(); y = 20; }

    //-----------------------------
    // GRAFIK DAYA
    //-----------------------------
    y = sectionTitle("Grafik Konsumsi Daya", y);

    if (powerChart) {
        doc.setDrawColor(...COLOR.cardBorder);
        doc.roundedRect(margin - 2, y - 2, contentWidth + 4, 74, 2, 2);
        doc.addImage(powerChart, "PNG", margin, y, contentWidth, 70);
    }
    y += 78;

    //-----------------------------
    // GRAFIK ARUS
    //-----------------------------
    if (y > 200) { doc.addPage(); y = 20; }

    y = sectionTitle("Grafik Arus Listrik", y);

    if (currentChart) {
        doc.setDrawColor(...COLOR.cardBorder);
        doc.roundedRect(margin - 2, y - 2, contentWidth + 4, 64, 2, 2);
        doc.addImage(currentChart, "PNG", margin, y, contentWidth, 60);
    }

    //=====================================================
    // HALAMAN — ANALISIS HASIL PENGUJIAN
    //=====================================================
    doc.addPage();
    y = 20;

    doc.setFont("helvetica","bold");
    doc.setFontSize(17);
    doc.setTextColor(...COLOR.primary);
    doc.text("ANALISIS HASIL PENGUJIAN", pageWidth/2, y, { align:"center" });
    doc.setTextColor(...COLOR.text);
    y += 5;
    doc.setDrawColor(...COLOR.line);
    doc.line(margin, y, pageWidth - margin, y);
    y += 12;

    y = sectionTitle("Ringkasan Rule Based Detection", y);

    const ringkasan = [
        ["Normal", normalCount, pNormal, COLOR.badgeNormalText],
        ["Warning", warningCount, pWarning, COLOR.badgeWarningText],
        ["High Consumption", highCount, pHigh, COLOR.badgeHighText],
        ["Short Circuit", shortCount, pShort, COLOR.badgeDangerText],
    ];
    ringkasan.forEach(([label, count, pct, color]) => {
        doc.setFont("helvetica","normal");
        doc.setFontSize(10.5);
        doc.setTextColor(...COLOR.textMuted);
        doc.text(label, margin, y);
        doc.setFont("helvetica","bold");
        doc.setTextColor(...color);
        doc.text(`${count}  (${pct}%)`, margin + 55, y);
        doc.setTextColor(...COLOR.text);
        y += 6.5;
    });

    y += 8;
    y = sectionTitle("Confidence Analysis", y);
    y = infoRow("Confidence Rata-rata", avgConfidence.toFixed(2) + " %", y);
    y = infoRow("Confidence Maksimum", maxConfidence.toFixed(2) + " %", y);
    y = infoRow("Confidence Minimum", minConfidence.toFixed(2) + " %", y);

    y += 8;
    y = sectionTitle("Interpretasi (Real-Time, dihitung dari data pengujian ini)", y);

    const interpretasiLines = doc.splitTextToSize(narasiRealtime, contentWidth);
    doc.setFont("helvetica","normal");
    doc.setFontSize(10.5);
    doc.text(interpretasiLines, margin, y);

    //=====================================================
    // HALAMAN — DATA HASIL PENGUJIAN (TABEL)
    //=====================================================
    doc.addPage();
    y = 20;

    doc.setFont("helvetica","bold");
    doc.setFontSize(16);
    doc.setTextColor(...COLOR.primary);
    doc.text("DATA HASIL PENGUJIAN", pageWidth/2, y, { align:"center" });
    doc.setTextColor(...COLOR.text);
    y += 5;
    doc.setDrawColor(...COLOR.line);
    doc.line(margin, y, pageWidth - margin, y);
    y += 8;

    const body = data.map((d,i)=>[
        i+1,
        d.waktu,
        Number(d.voltage).toFixed(1),
        Number(d.current).toFixed(3),
        Number(d.power).toFixed(2),
        d.status,
        Number(d.confidence || 0).toFixed(2)
    ]);

    doc.autoTable({
        startY: y,
        head: [["No","Waktu","Tegangan","Arus","Daya","Status","Confidence (%)"]],
        body: body,
        theme: "grid",
        styles: {
            fontSize: 8.5,
            cellPadding: 2.4,
            lineColor: COLOR.line,
            lineWidth: 0.2,
        },
        headStyles: {
            fillColor: COLOR.primary,
            textColor: 255,
            halign: "center",
            fontStyle: "bold",
            fontSize: 9,
        },
        bodyStyles: { halign: "center", textColor: COLOR.text },
        alternateRowStyles: { fillColor: COLOR.cardBg },
        margin: { left: margin, right: margin }
    });

    //=====================================================
    // HALAMAN — KESIMPULAN (REAL-TIME)
    //=====================================================
    doc.addPage();
    y = 30;

    doc.setFont("helvetica","bold");
    doc.setFontSize(18);
    doc.setTextColor(...COLOR.primary);
    doc.text("KESIMPULAN", pageWidth/2, y, { align:"center" });
    doc.setTextColor(...COLOR.text);
    y += 6;
    doc.setDrawColor(...COLOR.line);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;

    const kesimpulanLines = doc.splitTextToSize(narasiRealtime, contentWidth);
    doc.setFont("helvetica","normal");
    doc.setFontSize(11.5);
    doc.text(kesimpulanLines, margin, y);
    y += kesimpulanLines.length * 6 + 20;

    //------------------------------------------
    // TANDA TANGAN
    //------------------------------------------
    doc.setFont("helvetica","normal");
    doc.setFontSize(11);
    doc.text("Mengetahui,", 150, 220);
    doc.text("Penguji", 150, 227);
    doc.setDrawColor(...COLOR.text);
    doc.line(145, 260, 190, 260);

    //------------------------------------------
    // FOOTER + NOMOR HALAMAN (semua halaman)
    //------------------------------------------
    footerAndPageNum();

    //------------------------------------------
    // SIMPAN
    //------------------------------------------
    doc.save(namaAlat.replace(/\s+/g,"_") + "_Laporan_Pengujian.pdf");

}

async function resetProteksi() {

    if (!confirm("Reset proteksi dan hidupkan relay kembali?")) {
        return;
    }

    try {

        const res = await fetch(`${BASE_URL}/api/reset-proteksi`,{
    method:"POST"
})

        const data = await res.json();

        if (data.success) {

            alert("✅ Reset proteksi berhasil dikirim");

        } else {

            alert("❌ Reset gagal");

        }

    } catch (err) {

        console.error(err);
        alert("❌ Gagal koneksi ke server");

    }
}

function startPolling() {

    if (pollTimer) {
        clearTimeout(pollTimer);
    }

    async function poll() {

        await tick();

        pollTimer = setTimeout(poll, POLL_INTERVAL);

    }

    poll();

}
    window.addEventListener('DOMContentLoaded', () => {

    initNotification();

    initSidebar();
    initMainChart();
    initAllSparklines();
    initBebanPage();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js')
        .then(reg => {
            console.log('SW REGISTERED');
        })
        .catch(err => {
            console.log('SW FAILED', err);
        });
    }

    fetch(`${BASE_URL}/api/settings`)
    .then(res => res.json())
    .then(cfg => {

        CFG.warnPower = cfg.warnPower;
        CFG.highPower = cfg.highPower;
        CFG.shortPower = cfg.shortPower;

        document.getElementById('cfgWarn').value = cfg.warnPower;
        document.getElementById('cfgHigh').value = cfg.highPower;
        document.getElementById('cfgShort').value = cfg.shortPower;

        console.log("SETTINGS LOADED:", cfg);

    })
    .catch(err => console.error(err));

    renderLogs('ALL');
    setTimeout(initHistChart,100);

    startPolling();

});