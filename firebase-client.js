'use strict';

// REST resmi Firebase: tidak perlu mengunduh SDK/CDN agar UI dapat dibuka offline.
// Akses Firestore tetap menggunakan ID token Firebase dan Security Rules.
class FirebaseHistoryClient {
    constructor(config) {
        this.config = config;
        this.sessionKey = `valutax_auth_v2_${config.projectId}`;
        this.session = null;
        this.authPromise = null;
        this.session = this.readSession();
    }

    readSession() {
        const raw = localStorage.getItem(this.sessionKey);
        if (!raw) return null;
        let value;
        try { value = JSON.parse(raw); } catch (_) { throw new Error('SESSION_INVALID'); }
        if (!value || typeof value.uid !== 'string' || !value.uid || typeof value.idToken !== 'string' ||
            !value.idToken || typeof value.refreshToken !== 'string' || !value.refreshToken || !Number.isFinite(value.expiresAt))
            throw new Error('SESSION_INVALID');
        return value;
    }

    get uid() { return this.session ? this.session.uid : null; }

    async request(url, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
            let data;
            try { data = await response.json(); } catch (_) { throw new Error('Respons Firebase tidak valid.'); }
            if (!response.ok) {
                const error = new Error(data.error?.message || `Firebase HTTP ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return data;
        } finally { clearTimeout(timeout); }
    }

    async authenticate(forceRefresh = false) {
        if (this.authPromise) return this.authPromise;
        const previousToken = this.session?.idToken;
        const authenticate = async () => {
            const persisted = this.readSession();
            if (this.session && persisted && this.session.uid !== persisted.uid) throw new Error('SESSION_CHANGED');
            if (persisted) this.session = persisted;
            const refreshedByOtherTab = this.session?.idToken !== previousToken;
            if (this.session && this.session.expiresAt > Date.now() + 60000 && (!forceRefresh || refreshedByOtherTab)) return this.session;
            return this.obtainSession();
        };
        // Web Locks menghindari dua signup/refresh bersamaan pada tab berbeda.
        this.authPromise = navigator.locks?.request ?
            navigator.locks.request(`valutax-auth-${this.config.projectId}`, authenticate) : authenticate();
        try { return await this.authPromise; }
        finally { this.authPromise = null; }
    }

    async obtainSession() {
        const key = encodeURIComponent(this.config.apiKey);
        let data;
        let session;
        if (this.session) {
            data = await this.request(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.session.refreshToken }).toString()
            });
            if (data.user_id !== this.session.uid) throw new Error('Identitas sesi berubah. Sinkronisasi dihentikan.');
            session = { uid: data.user_id, idToken: data.id_token, refreshToken: data.refresh_token,
                expiresAt: Date.now() + Number(data.expires_in) * 1000 };
        } else {
            data = await this.request(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ returnSecureToken: true })
            });
            session = { uid: data.localId, idToken: data.idToken, refreshToken: data.refreshToken,
                expiresAt: Date.now() + Number(data.expiresIn) * 1000 };
        }
        if (typeof session.uid !== 'string' || !session.uid || typeof session.idToken !== 'string' || !session.idToken ||
            typeof session.refreshToken !== 'string' || !session.refreshToken || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
            throw new Error('Respons sesi Firebase tidak lengkap.');
        }
        // Persistensi sesi wajib berhasil sebelum dokumen lokal diberi UID ini.
        localStorage.setItem(this.sessionKey, JSON.stringify(session));
        this.session = session;
        return session;
    }

    async authorizedRequest(url, options = {}, retry = true) {
        const session = await this.authenticate();
        try {
            return await this.request(url, { ...options,
                headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${session.idToken}` } });
        } catch (error) {
            if (error.status === 401 && retry) {
                await this.authenticate(true);
                return this.authorizedRequest(url, options, false);
            }
            throw error;
        }
    }

    collectionURL() {
        return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(this.config.projectId) +
            '/databases/(default)/documents/users/' + encodeURIComponent(this.uid) + '/conversions';
    }

    async readHistory(pageSize = 50) {
        await this.authenticate();
        // Firestore REST membutuhkan spasi query sebagai %20, bukan tanda + form.
        const params = `pageSize=${encodeURIComponent(pageSize)}&orderBy=${encodeURIComponent('savedAt desc')}`;
        const data = await this.authorizedRequest(`${this.collectionURL()}?${params}`);
        if (data.documents !== undefined && !Array.isArray(data.documents)) throw new Error('Data riwayat Firebase tidak valid.');
        return (data.documents || []).filter(document => typeof document.name === 'string').map(document => {
            const f = document.fields || {};
            const number = name => Number(f[name]?.doubleValue ?? f[name]?.integerValue);
            return {
                id: document.name.split('/').pop(), amount: number('amount'), result: number('result'), rate: number('rate'),
                from: f.from?.stringValue, to: f.to?.stringValue, source: f.source?.stringValue,
                savedAt: f.savedAt?.timestampValue, rateUpdatedAt: f.rateUpdatedAt?.timestampValue,
                uid: this.uid, projectId: this.config.projectId, synced: true
            };
        });
    }

    async writeRecord(record) {
        await this.authenticate();
        if (record.uid !== this.uid || record.projectId !== this.config.projectId) throw new Error('Identitas riwayat tidak sesuai.');
        const fields = {
            amount: { doubleValue: record.amount }, from: { stringValue: record.from }, to: { stringValue: record.to },
            result: { doubleValue: record.result }, rate: { doubleValue: record.rate }, source: { stringValue: record.source },
            savedAt: { timestampValue: record.savedAt }, rateUpdatedAt: { timestampValue: record.rateUpdatedAt }
        };
        // PATCH dengan ID tetap: jika respons terputus setelah server menyimpan,
        // pengiriman ulang memperbarui dokumen yang sama, bukan membuat duplikat.
        const data = await this.authorizedRequest(`${this.collectionURL()}/${encodeURIComponent(record.id)}`, {
            method: 'PATCH', body: JSON.stringify({ fields })
        });
        if (!data.name || !data.updateTime) throw new Error('Firebase belum mengonfirmasi penyimpanan.');
    }
}
window.FirebaseHistoryClient = FirebaseHistoryClient;
