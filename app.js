'use strict';

const FLAGS_MAP = { USD: '$', IDR: 'Rp', EUR: '€', GBP: '£', JPY: '¥', SGD: 'S$', MYR: 'RM', CNY: '¥', XAU: 'Au' };
const CURRENCY_CODES = Object.keys(FLAGS_MAP);
const FIAT_CODES = CURRENCY_CODES.filter(code => code !== 'XAU');
const GRAMS_PER_TROY_OUNCE = 31.1034768;
// Data CONTOH untuk demonstrasi saat belum pernah memperoleh data dari API.
const DEFAULT_FALLBACK_RATES = { USD: 1, IDR: 15850, EUR: 0.92, GBP: 0.79, JPY: 152.4, SGD: 1.34, MYR: 4.45, CNY: 7.23 };
const CACHE_KEY = 'valutax_rates_v2';
const RECORD_PREFIX = 'valutax_record_v2_';
const MAX_AMOUNT = 1e12;
const configState = window.ValutaXConfig.resolve();
const config = configState.config;
const firebaseConfigured = Boolean(config);

let exchangeRates = { ...DEFAULT_FALLBACK_RATES };
let rateSource = 'demo';
let rateUpdatedAt = null;
let goldUpdatedAt = null;
let goldSource = 'unavailable';
let lastGoldFetch = 0;
let rateMessage = '';
let deviceOnline = navigator.onLine;
let firebaseClient = null;
let syncBusy = false;
let cloudState = 'unconfigured';
let cloudDetail = configState.error || 'Riwayat cloud belum diaktifkan. Buka Pengaturan Firebase untuk menghubungkan proyek.';
let cloudRetryable = true;
let lastSyncAt = 0;
let latestConversion = null;
let ratesController = null;
let refreshVersion = 0;
let storageAvailable = true;

function el(id) { return document.getElementById(id); }
let navigationPreference = null;

function setActiveNavigation(id) {
    document.querySelectorAll('.app-nav [data-section]').forEach(button => {
        const active = button.dataset.section === id;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'location');
        else button.removeAttribute('aria-current');
    });
}

function scrollToSection(id) {
    navigationPreference = id;
    setActiveNavigation(id);
    const content = document.querySelector('.app-content');
    const section = el(id).closest('main, section');
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (content) content.scrollTo({ top: section.offsetTop - 14, behavior });
    else el(id).scrollIntoView({ behavior, block: 'start' });
}

function initializeNavigation() {
    const content = document.querySelector('.app-content');
    const root = content || window;
    const sections = [
        { id: 'converterHeading', element: el('converterHeading').closest('main') },
        { id: 'chartTitle', element: el('chartTitle').closest('.insights-column') },
        { id: 'historyHeading', element: el('historyHeading').closest('section') }
    ];
    let scheduled = false;

    const update = () => {
        scheduled = false;
        const bounds = content?.getBoundingClientRect();
        const top = bounds ? bounds.top : Math.max(0, document.querySelector('.app-header').getBoundingClientRect().bottom);
        const bottom = bounds ? bounds.bottom : innerHeight;
        const probe = top + Math.min(120, (bottom - top) * 0.25);
        const positions = sections.map(section => ({ ...section, rect: section.element.getBoundingClientRect() }));
        const scroller = content || document.scrollingElement;
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const history = positions[2];

        if (maxScroll > 1 && maxScroll - scroller.scrollTop <= 2 && history.rect.top < bottom && history.rect.bottom > top) {
            setActiveNavigation(history.id);
            return;
        }

        let candidates = positions.filter(section => section.rect.top <= probe && section.rect.bottom > probe);
        if (!candidates.length) {
            const passed = positions.filter(section => section.rect.top <= probe);
            const latestTop = Math.max(...passed.map(section => section.rect.top));
            candidates = passed.filter(section => latestTop - section.rect.top < 24);
        }
        const current = document.querySelector('.app-nav [aria-current="location"]')?.dataset.section;
        const chosen = candidates.find(section => section.id === navigationPreference) ||
            candidates.find(section => section.id === current) || candidates[0];
        if (chosen?.id === navigationPreference) navigationPreference = null;
        setActiveNavigation(chosen?.id || 'converterHeading');
    };

    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(update);
    };
    root.addEventListener('scroll', schedule, { passive: true });
    root.addEventListener('wheel', () => { navigationPreference = null; }, { passive: true });
    root.addEventListener('touchmove', () => { navigationPreference = null; }, { passive: true });
    window.addEventListener('resize', schedule);
    if ('ResizeObserver' in window) {
        const observer = new ResizeObserver(schedule);
        sections.forEach(section => observer.observe(section.element));
    }
    schedule();
}
function readJSON(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (_) { return null; }
}
function storeJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function showMessage(message, isError = false) {
    el('actionMessage').textContent = message;
    el('actionMessage').classList.toggle('error-text', isError);
}

function validRates(rates) {
    return rates && FIAT_CODES.every(code => typeof rates[code] === 'number' && Number.isFinite(rates[code]) &&
        rates[code] > 0 && rates[code] < 1e12) && rates.USD === 1;
}
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validRecord(record) {
    return record && typeof record.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(record.id) &&
        CURRENCY_CODES.includes(record.from) && CURRENCY_CODES.includes(record.to) &&
        Number.isFinite(record.amount) && record.amount > 0 && record.amount <= MAX_AMOUNT &&
        Number.isFinite(record.result) && record.result > 0 && record.result <= 1e20 &&
        Number.isFinite(record.rate) && record.rate > 0 && record.rate <= 1e12 &&
        ['api', 'cache'].includes(record.source) && validDate(record.savedAt) && validDate(record.rateUpdatedAt) &&
        (record.projectId === null || typeof record.projectId === 'string') &&
        (record.uid === null || typeof record.uid === 'string') && typeof record.synced === 'boolean';
}

function allRecords() {
    const records = [];
    try {
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (key?.startsWith(RECORD_PREFIX)) {
                const record = readJSON(key);
                if (validRecord(record)) records.push(record);
            }
        }
    } catch (_) { storageAvailable = false; }
    return records;
}

function currentRecords() {
    const project = firebaseConfigured ? config.projectId : null;
    const uid = firebaseClient?.uid || null;
    return allRecords().filter(record => (record.projectId === null || record.projectId === project) &&
        (record.uid === null || !uid || record.uid === uid)).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

function initTheme() {
    let savedTheme;
    try { savedTheme = localStorage.getItem('valutax_app_theme'); } catch (_) { /* tema default */ }
    const light = savedTheme !== 'dark';
    document.body.classList.toggle('light-theme', light);
    el('themeIcon').textContent = light ? '☾' : '☀';
    el('themeToggle').setAttribute('aria-label', light ? 'Gunakan tema gelap' : 'Gunakan tema terang');
    el('themeToggle').setAttribute('aria-pressed', String(!light));
}
function toggleTheme() {
    const light = document.body.classList.toggle('light-theme');
    el('themeIcon').textContent = light ? '☾' : '☀';
    el('themeToggle').setAttribute('aria-label', light ? 'Gunakan tema gelap' : 'Gunakan tema terang');
    el('themeToggle').setAttribute('aria-pressed', String(!light));
    try { localStorage.setItem('valutax_app_theme', light ? 'light' : 'dark'); } catch (_) { /* tema tetap berlaku */ }
}
function updateDeviceTime() {
    el('deviceTime').textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function displayTime(value) {
    return validDate(value) ? new Date(value).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : 'tidak diketahui';
}
function formatNumber(number) {
    if (!Number.isFinite(number)) return '—';
    if (number !== 0 && Math.abs(number) < 0.000001) return number.toExponential(4).replace('.', ',');
    return new Intl.NumberFormat('id-ID', { maximumFractionDigits: number > 0 && number < 1 ? 6 : 2 }).format(number);
}
function unitLabel(code) { return code === 'XAU' ? 'gram emas' : code; }

function loadRatesCache() {
    const cache = readJSON(CACHE_KEY);
    if (cache && validRates(cache.rates) && validDate(cache.updatedAt)) {
        exchangeRates = Object.fromEntries(FIAT_CODES.map(code => [code, cache.rates[code]]));
        rateUpdatedAt = cache.updatedAt;
        rateSource = 'cache';
    }
    const gold = readJSON('valutax_gold_v1');
    if (gold && Number.isFinite(gold.usdPerTroyOunce) && gold.usdPerTroyOunce > 0 && gold.usdPerTroyOunce < 1e9 && validDate(gold.updatedAt)) {
        exchangeRates.XAU = GRAMS_PER_TROY_OUNCE / gold.usdPerTroyOunce;
        goldUpdatedAt = gold.updatedAt;
        goldSource = 'cache';
        if (Number.isFinite(gold.fetchedAt) && gold.fetchedAt <= Date.now()) lastGoldFetch = gold.fetchedAt;
    }
    updateGoldOptions();
}

function updateGoldOptions() {
    for (const select of [el('fromCurrency'), el('toCurrency')]) {
        const option = select.querySelector('option[value="XAU"]');
        option.disabled = goldSource === 'unavailable';
        option.textContent = goldSource === 'unavailable' ? 'Emas (menunggu harga)' : 'Emas (gram)';
    }
}

function renderRateStatus() {
    const demo = rateSource === 'demo';
    el('rateStatus').textContent = demo ? 'Data contoh • bukan kurs terbaru' :
        `${rateSource === 'api' ? 'Kurs dari API' : 'Kurs tersimpan'} • ${displayTime(rateUpdatedAt)}`;
    el('rateStatus').classList.toggle('warning-text', demo || rateSource === 'cache');
    el('goldRateStatus').textContent = goldSource === 'unavailable' ? 'Harga emas belum tersedia. Coba perbarui saat online.' :
        `Emas ${goldSource === 'api' ? 'dari API' : 'tersimpan'} • ${displayTime(goldUpdatedAt)} • satuan gram`;
    const showNotice = demo || Boolean(rateMessage) || !deviceOnline;
    el('offlineNotice').classList.toggle('hidden', !showNotice);
    el('offlineNoticeText').textContent = rateMessage || (demo ?
        'Belum ada kurs valuta tersimpan. Valuta memakai data contoh; harga emas diperiksa terpisah.' :
        'Perangkat offline. Perhitungan dan grafik memakai kurs terakhir, bukan pembaruan langsung.');
}

async function fetchLiveRates() {
    const version = ++refreshVersion;
    ratesController?.abort();
    if (!deviceOnline) {
        if (rateSource === 'api') rateSource = 'cache';
        if (goldSource === 'api') goldSource = 'cache';
        rateMessage = '';
        el('refreshIcon').classList.remove('spinning');
        performConversion();
        renderRateStatus();
        return;
    }
    const controller = new AbortController();
    ratesController = controller;
    el('refreshIcon').classList.add('spinning');
    const timeout = setTimeout(() => controller.abort(), 8000);
    const goldTask = fetchGoldPrice(controller.signal);
    try {
        const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Layanan kurs gagal merespons.');
        const data = await response.json();
        if (data.result !== 'success' || !validRates(data.rates)) throw new Error('Data kurs tidak lengkap.');
        const timestamp = Number(data.time_last_update_unix) * 1000;
        if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 86400000)
            throw new Error('Waktu sumber kurs tidak valid.');
        if (version !== refreshVersion || !deviceOnline) return;
        exchangeRates = { ...Object.fromEntries(FIAT_CODES.map(code => [code, data.rates[code]])),
            ...(exchangeRates.XAU ? { XAU: exchangeRates.XAU } : {}) };
        rateUpdatedAt = new Date(timestamp).toISOString();
        rateSource = 'api';
        rateMessage = '';
        try { storeJSON(CACHE_KEY, { rates: exchangeRates, updatedAt: rateUpdatedAt }); }
        catch (_) { rateMessage = 'Kurs berhasil diambil, tetapi cache perangkat tidak bisa disimpan.'; }
        performConversion();
        renderRateStatus();
    } catch (_) {
        if (version !== refreshVersion) return;
        if (rateSource === 'api') rateSource = 'cache';
        rateMessage = rateSource === 'demo' ?
            'Layanan kurs belum bisa diakses dan belum ada cache. Menggunakan data contoh.' :
            'Layanan kurs belum bisa diakses. Menggunakan kurs terakhir yang tersimpan.';
    } finally {
        await goldTask;
        clearTimeout(timeout);
        if (version === refreshVersion) {
            el('refreshIcon').classList.remove('spinning');
            performConversion();
            renderRateStatus();
        }
    }
}

async function fetchGoldPrice(signal) {
    // Sumber meminta cache 30 detik; hindari permintaan berulang dalam jeda itu.
    if (Date.now() - lastGoldFetch < 30000 && goldSource !== 'unavailable') return;
    try {
        const response = await fetch('https://api.gold-api.com/price/XAU', { signal });
        if (!response.ok) throw new Error('Harga emas belum tersedia');
        const data = await response.json();
        if (data.symbol !== 'XAU' || (data.currency && data.currency !== 'USD') ||
            typeof data.price !== 'number' || !Number.isFinite(data.price) || data.price <= 0 || data.price >= 1e9 ||
            !validDate(data.updatedAt) || Date.parse(data.updatedAt) > Date.now() + 86400000) throw new Error('Harga emas tidak valid');
        if (signal.aborted || !deviceOnline) return;
        exchangeRates.XAU = GRAMS_PER_TROY_OUNCE / data.price;
        goldUpdatedAt = new Date(data.updatedAt).toISOString();
        goldSource = 'api';
        lastGoldFetch = Date.now();
        try { storeJSON('valutax_gold_v1', { usdPerTroyOunce: data.price, updatedAt: goldUpdatedAt, fetchedAt: lastGoldFetch }); }
        catch (_) { showMessage('Harga emas berhasil diambil, tetapi cache perangkat tidak bisa disimpan.', true); }
    } catch (_) { if (ratesController?.signal === signal && goldSource === 'api') goldSource = 'cache'; }
    finally {
        updateGoldOptions();
        if (!signal.aborted) { performConversion(); renderRateStatus(); }
    }
}

function updateCurrencyUI(type) {
    const code = el(`${type}Currency`).value;
    el(`${type}Flag`).textContent = FLAGS_MAP[code] || '◉';
    el(`${type}Flag`).setAttribute('aria-label', code);
    performConversion();
}

function performConversion() {
    const from = el('fromCurrency').value;
    const to = el('toCurrency').value;
    const raw = el('fromAmount').value;
    const amount = Number(raw);
    const valid = raw.trim() !== '' && Number.isFinite(amount) && amount >= 0 && amount <= MAX_AMOUNT &&
        Number.isFinite(exchangeRates[from]) && Number.isFinite(exchangeRates[to]);
    const ratio = valid ? exchangeRates[to] / exchangeRates[from] : NaN;
    const result = amount * ratio;
    const resultValid = valid && Number.isFinite(result) && result <= 1e20;
    el('amountError').textContent = valid ? '' : 'Masukkan nominal 0–1.000.000.000.000.';
    el('fromAmount').setAttribute('aria-invalid', String(!valid));
    el('toAmount').value = resultValid ? formatNumber(result) : '—';
    el('fromAmount').classList.toggle('compact-number', raw.length > 10);
    el('toAmount').classList.toggle('compact-number', el('toAmount').value.length > 16);
    el('exchangeRateRatio').textContent = Number.isFinite(ratio) ? `1 ${unitLabel(from)} = ${formatNumber(ratio)} ${unitLabel(to)}` : 'Nilai tukar tidak tersedia';
    latestConversion = resultValid ? { from, to, amount, result, rate: ratio } : null;
    const involvesGold = from === 'XAU' || to === 'XAU';
    const needsFiatRates = [from, to].some(code => code !== 'USD' && code !== 'XAU');
    const sourceValid = (!needsFiatRates || rateSource !== 'demo') && (!involvesGold || goldSource !== 'unavailable') &&
        (involvesGold || rateSource !== 'demo');
    if (latestConversion) {
        latestConversion.source = (needsFiatRates && rateSource === 'cache') || (involvesGold && goldSource === 'cache') ? 'cache' : 'api';
        const dates = [needsFiatRates || !involvesGold ? rateUpdatedAt : null, involvesGold ? goldUpdatedAt : null].filter(validDate);
        latestConversion.rateUpdatedAt = dates.length ? new Date(Math.min(...dates.map(Date.parse))).toISOString() : null;
    }
    el('saveHistoryBtn').disabled = !storageAvailable || !latestConversion || amount <= 0 || !sourceValid;
    el('saveHistoryBtn').title = !sourceValid ? 'Ambil kurs atau harga emas dari internet terlebih dahulu.' : 'Simpan hasil ini ke riwayat';
    renderComparisonChart();
}

function swapCurrencies() {
    const previous = el('fromCurrency').value;
    el('fromCurrency').value = el('toCurrency').value;
    el('toCurrency').value = previous;
    updateCurrencyUI('from');
    updateCurrencyUI('to');
}
function setQuickAmount(value) {
    // Tombol bertanda + benar-benar menambah nominal, bukan menggantinya.
    const current = Number(el('fromAmount').value) || 0;
    el('fromAmount').value = Math.min(MAX_AMOUNT, Math.max(0, current) + value);
    performConversion();
}

function renderComparisonChart() {
    const target = el('toCurrency').value;
    const codes = ['EUR', 'GBP', 'MYR', 'SGD', 'CNY'];
    const values = codes.map(code => exchangeRates[target] / exchangeRates[code]);
    const max = Math.max(...values);
    const chart = el('comparisonChart');
    chart.replaceChildren();
    el('chartTitle').textContent = `Nilai 1 valuta dalam ${unitLabel(target)}`;
    el('chartDescription').textContent = `Setiap batang menunjukkan nilai 1 unit mata uang dalam ${unitLabel(target)}. Grafik mengikuti mata uang tujuan, bukan nominal input. ${rateSource === 'demo' ? 'Data contoh.' : 'Waktu kurs: ' + displayTime(rateUpdatedAt) + '.'}`;
    codes.forEach((code, index) => {
        const row = document.createElement('li');
        row.className = 'chart-row';
        const label = document.createElement('span');
        label.className = 'chart-code';
        label.textContent = code;
        const track = document.createElement('span');
        track.className = 'chart-track';
        track.setAttribute('aria-hidden', 'true');
        const bar = document.createElement('span');
        bar.className = 'chart-fill';
        bar.style.width = `${Number.isFinite(values[index]) && max > 0 ? values[index] / max * 100 : 0}%`;
        track.append(bar);
        const value = document.createElement('span');
        value.className = 'chart-value';
        value.textContent = `${formatNumber(values[index])} ${unitLabel(target)}`;
        row.append(label, track, value);
        chart.append(row);
    });
}

function renderConnectionStatus() {
    el('networkStatus').className = `status-badge ${deviceOnline ? 'online' : 'offline'}`;
    el('statusText').textContent = deviceOnline ? 'Online' : 'Offline';
    el('networkStatus').title = 'Status jaringan perangkat; koneksi Firebase diperiksa terpisah.';
    const labels = { unconfigured: 'Belum diatur', connecting: 'Menghubungkan…', online: 'Terhubung',
        offline: 'Menunggu jaringan', error: 'Belum terhubung' };
    el('firebaseStatus').textContent = labels[cloudState];
    el('firebaseStatus').className = `firebase-status ${cloudState}`;
    el('firebaseDetail').textContent = cloudDetail;
    el('syncBtn').disabled = !deviceOnline || !firebaseConfigured || !storageAvailable || syncBusy;
    el('pendingCount').textContent = String(currentRecords().filter(record => !record.synced).length);
}

function renderHistory() {
    const all = currentRecords();
    const records = all.slice(0, 50);
    const list = el('historyList');
    list.replaceChildren();
    el('historyEmpty').classList.toggle('hidden', records.length > 0);
    records.forEach(record => {
        const item = document.createElement('li');
        item.className = 'history-item';
        const title = document.createElement('strong');
        title.textContent = `${formatNumber(record.amount)} ${unitLabel(record.from)} → ${formatNumber(record.result)} ${unitLabel(record.to)}`;
        const description = document.createElement('small');
        description.textContent = `${displayTime(record.savedAt)} · Kurs ${displayTime(record.rateUpdatedAt)}`;
        const syncLabel = document.createElement('span');
        syncLabel.className = `history-state ${record.synced ? 'is-synced' : 'is-pending'}`;
        syncLabel.textContent = record.synced ? 'Tersimpan di Firebase' : 'Menunggu sinkronisasi';
        item.append(title, description, syncLabel);
        list.append(item);
    });
    el('historyCount').textContent = all.length > 50 ? `50 terbaru dari ${all.length} riwayat` : `${all.length} riwayat`;
    if (!storageAvailable) el('saveHistoryBtn').disabled = true;
    renderConnectionStatus();
}

function exportHistory() {
    const records = allRecords().filter(record => !config || record.projectId === null || record.projectId === config.projectId);
    const content = JSON.stringify({ format: 'valutax-history-v1', exportedAt: new Date().toISOString(), records }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'ValutaX_riwayat.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveConversion() {
    if (!latestConversion || latestConversion.amount <= 0 || el('saveHistoryBtn').disabled || !storageAvailable) return;
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() :
        `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(2))).join('-')}`;
    const record = { ...latestConversion, id, savedAt: new Date().toISOString(),
        projectId: firebaseConfigured ? config.projectId : null, uid: firebaseClient?.uid || null, synced: false };
    if (!validRecord(record)) { showMessage('Hasil tidak dapat disimpan. Periksa nominal dan kurs.', true); return; }
    try { storeJSON(RECORD_PREFIX + id, record); }
    catch (_) { showMessage('Penyimpanan perangkat penuh atau diblokir. Riwayat belum disimpan.', true); return; }
    showMessage('Riwayat tersimpan di perangkat. Status Firebase terlihat pada daftar di bawah.');
    renderHistory();
    void syncHistory();
}

function firebaseErrorMessage(error) {
    const message = error.message || '';
    if (/SESSION_INVALID|SESSION_CHANGED/.test(message)) return 'Sesi browser berubah atau rusak. Riwayat lokal tetap dipertahankan; buka panduan pemulihan sebelum menghapus data situs.';
    if (/OPERATION_NOT_ALLOWED/.test(message)) return 'Aktifkan Anonymous pada Firebase Authentication. Riwayat tetap tersimpan lokal.';
    if (/API_KEY|PROJECT_NOT_FOUND|INVALID_PROJECT/.test(message)) return 'Periksa konfigurasi proyek Firebase. Riwayat tetap tersimpan lokal.';
    if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT/.test(message))
        return 'Sesi Firebase tidak berlaku. Periksa Authentication proyek; riwayat lokal tetap dipertahankan.';
    if (error.status === 403) return 'Akses Firebase ditolak. Periksa Security Rules dan izin API. Riwayat tetap tersimpan lokal.';
    if (error.status === 404) return 'Database Firestore (default) belum ditemukan. Periksa proyek dan pembuatan database.';
    if (error.status === 429) return 'Batas layanan Firebase tercapai. Coba sinkronisasi lagi nanti; riwayat tetap lokal.';
    if (/quota|storage|persist/i.test(message)) return 'Penyimpanan perangkat tidak tersedia. Periksa izin browser.';
    return 'Firebase belum bisa diakses. Riwayat tetap lokal; aplikasi mencoba lagi setiap 30 detik saat online.';
}

async function syncHistory(full = true) {
    if (syncBusy) return;
    if (!firebaseConfigured) {
        cloudState = 'unconfigured';
        renderConnectionStatus();
        return;
    }
    if (!deviceOnline) {
        cloudState = 'offline';
        cloudDetail = 'Perangkat offline. Riwayat baru tetap lokal dan akan dikirim setelah koneksi pulih.';
        renderConnectionStatus();
        return;
    }
    if (!storageAvailable) return;
    if (!full && cloudState === 'online' && Date.now() - lastSyncAt < 120000 &&
        !currentRecords().some(record => !record.synced)) return;
    syncBusy = true;
    const previousState = cloudState;
    cloudState = 'connecting';
    cloudDetail = 'Memeriksa akses database dan mengirim riwayat yang tertunda…';
    renderConnectionStatus();
    const synchronize = async () => {
        if (!firebaseClient) firebaseClient = new window.FirebaseHistoryClient(config);
        await firebaseClient.authenticate();
        if (!deviceOnline) return;
        // Berhasil membaca dari server membuktikan koneksi, bukan navigator.onLine.
        const remoteRecords = await firebaseClient.readHistory(full || !lastSyncAt || previousState !== 'online' ? 50 : 1);
        if (!deviceOnline) return;
        for (const record of remoteRecords) {
            if (!validRecord(record)) continue;
            const local = readJSON(RECORD_PREFIX + record.id);
            if (!local || (local.projectId === record.projectId && local.uid === record.uid)) {
                storeJSON(RECORD_PREFIX + record.id, record);
            }
        }
        const pending = currentRecords().filter(record => !record.synced).slice(0, 50);
        for (const original of pending) {
            if (!deviceOnline) return;
            const record = { ...original, projectId: config.projectId, uid: firebaseClient.uid };
            // Identitas riwayat disimpan sebelum permintaan agar pengiriman ulang tetap menggunakan UID yang sama.
            storeJSON(RECORD_PREFIX + record.id, record);
            await firebaseClient.writeRecord(record);
            storeJSON(RECORD_PREFIX + record.id, { ...record, synced: true });
        }
        if (deviceOnline) {
            cloudState = 'online';
            cloudRetryable = true;
            lastSyncAt = Date.now();
            cloudDetail = `Database terakhir berhasil diakses ${displayTime(new Date().toISOString())}. Riwayat milik browser ini.`;
        }
    };
    try {
        if (navigator.locks?.request) await navigator.locks.request(`valutax-sync-${config.projectId}`, synchronize);
        else await synchronize();
    } catch (error) {
        cloudState = deviceOnline ? 'error' : 'offline';
        cloudDetail = deviceOnline ? firebaseErrorMessage(error) : 'Perangkat offline. Riwayat tetap tersimpan lokal.';
        cloudRetryable = ![400, 403, 404].includes(error.status) &&
            !/SESSION_|OPERATION_NOT_ALLOWED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT/.test(error.message || '');
    } finally {
        syncBusy = false;
        if (!deviceOnline) {
            cloudState = 'offline';
            cloudDetail = 'Perangkat offline. Riwayat baru menunggu sinkronisasi.';
        }
        renderHistory();
        // Entry yang ditambah saat pengiriman sedang berjalan ikut dikirim segera.
        if (cloudState === 'online' && currentRecords().some(record => !record.synced))
            setTimeout(() => { void syncHistory(false); }, 100);
    }
}

function handleNetworkChange(online) {
    deviceOnline = online;
    if (!online) {
        refreshVersion++;
        ratesController?.abort();
        el('refreshIcon').classList.remove('spinning');
        if (rateSource === 'api') rateSource = 'cache';
        if (goldSource === 'api') goldSource = 'cache';
        rateMessage = '';
        if (firebaseConfigured) {
            cloudState = 'offline';
            cloudDetail = 'Perangkat offline. Riwayat baru menunggu sinkronisasi.';
        }
        performConversion();
        renderRateStatus();
        renderConnectionStatus();
    } else {
        renderConnectionStatus();
        void fetchLiveRates();
        void syncHistory();
    }
}

async function registerOfflineShell() {
    if ('serviceWorker' in navigator && ['http:', 'https:'].includes(location.protocol)) {
        let readyTimer;
        try {
            await navigator.serviceWorker.register('./sw.js');
            await Promise.race([navigator.serviceWorker.ready,
                new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Cache belum siap')), 10000); })]);
            el('offlineReady').textContent = 'Halaman siap dibuka ulang offline pada browser ini.';
        } catch (_) {
            el('offlineReady').textContent = 'Aplikasi tetap berjalan selama halaman terbuka. Pembukaan ulang offline belum tersedia.';
        } finally { clearTimeout(readyTimer); }
    }
}

function fitPhoneFrame() {
    const frame = document.querySelector('.phone-wrapper');
    if (!frame) return;
    const mobile = matchMedia('(max-width: 480px)').matches;
    const scale = mobile ? 1 : Math.max(0.1, Math.min(1, (innerHeight - 36) / 820, (innerWidth - 36) / 390));
    frame.style.setProperty('--phone-scale', scale);
}

function initializeApp() {
    fitPhoneFrame();
    window.addEventListener('resize', fitPhoneFrame);
    try {
        localStorage.setItem('valutax_storage_probe', '1');
        localStorage.removeItem('valutax_storage_probe');
    } catch (_) {
        storageAvailable = false;
        showMessage('Penyimpanan browser diblokir. Riwayat belum dapat disimpan.', true);
        if (firebaseConfigured) {
            cloudState = 'error';
            cloudDetail = 'Penyimpanan browser diblokir. Izinkan penyimpanan agar sesi dan riwayat dapat dipertahankan.';
        }
    }
    if (firebaseConfigured && storageAvailable) {
        try { firebaseClient = new window.FirebaseHistoryClient(config); }
        catch (error) { cloudState = 'error'; cloudDetail = firebaseErrorMessage(error); cloudRetryable = false; }
    }
    initTheme();
    updateDeviceTime();
    setInterval(updateDeviceTime, 10000);
    loadRatesCache();
    performConversion();
    renderRateStatus();
    renderHistory();
    initializeNavigation();
    window.addEventListener('online', () => handleNetworkChange(true));
    window.addEventListener('offline', () => handleNetworkChange(false));
    window.addEventListener('storage', event => { if (event.key?.startsWith(RECORD_PREFIX)) renderHistory(); });
    document.addEventListener('deviceready', () => {
        document.addEventListener('online', () => handleNetworkChange(true));
        document.addEventListener('offline', () => handleNetworkChange(false));
    }, { once: true });
    setInterval(() => { if (deviceOnline && cloudRetryable) void syncHistory(false); }, 30000);
    void fetchLiveRates();
    void syncHistory();
    void registerOfflineShell();
}

window.addEventListener('DOMContentLoaded', initializeApp, { once: true });
