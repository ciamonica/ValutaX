'use strict';
// Parser terbatas: konfigurasi hanya berisi pasangan nama dan string. Tidak ada eval.
window.ValutaXConfig = (() => {
    const storageKey = 'valutax_firebase_config_v1';
    const keys = ['apiKey', 'projectId', 'authDomain', 'databaseURL', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];
    function normalize(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tempel objek firebaseConfig dari aplikasi Web.');
        if ('private_key' in value || 'client_email' in value || value.type === 'service_account')
            throw new Error('Ini file service account. Gunakan konfigurasi aplikasi Web, bukan private key.');
        if (typeof value.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.projectId))
            throw new Error('projectId belum valid. Salin ulang dari pengaturan proyek Firebase.');
        if (typeof value.apiKey !== 'string' || !/^AIza[A-Za-z0-9_-]{35}$/.test(value.apiKey))
            throw new Error('apiKey belum valid. Salin Web API key dari proyek Firebase yang sama.');
        const result = {};
        for (const key of keys) {
            if (value[key] !== undefined) {
                if (typeof value[key] !== 'string' || value[key].length > 500) throw new Error(`Nilai ${key} harus berupa teks konfigurasi.`);
                result[key] = value[key];
            }
        }
        return result;
    }
    function parse(input) {
        let text = input.trim();
        try { return normalize(JSON.parse(text)); } catch (error) {
            if (error.name !== 'SyntaxError') throw error;
        }
        const marker = /(?:\b(?:const|let|var)\s+firebaseConfig|window\.VALUTAX_FIREBASE_CONFIG)\s*=\s*/.exec(text);
        if (marker) text = text.slice(marker.index + marker[0].length);
        let index = 0;
        function skip() {
            for (;;) {
                while (/\s/.test(text[index] || '') && index < text.length) index++;
                if (text.slice(index, index + 2) === '//') {
                    while (index < text.length && text[index] !== '\n') index++;
                } else if (text.slice(index, index + 2) === '/*') {
                    const end = text.indexOf('*/', index + 2);
                    if (end < 0) throw new Error('Komentar konfigurasi belum ditutup.');
                    index = end + 2;
                } else break;
            }
        }
        function quoted() {
            const quote = text[index++];
            if (quote !== '"' && quote !== "'") throw new Error('Nilai konfigurasi harus berada dalam tanda kutip.');
            let value = '';
            while (index < text.length) {
                const character = text[index++];
                if (character === quote) return value;
                if (character === '\\') {
                    const escape = text[index++];
                    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '/': '/', '"': '"', "'": "'" };
                    if (escape === 'u') {
                        const hex = text.slice(index, index + 4);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Escape konfigurasi tidak valid.');
                        value += String.fromCharCode(parseInt(hex, 16)); index += 4;
                    } else if (Object.hasOwn(escapes, escape)) value += escapes[escape];
                    else throw new Error('Escape konfigurasi tidak valid.');
                } else {
                    if (character === '\n' || character === '\r') throw new Error('Nilai konfigurasi terpotong.');
                    value += character;
                }
            }
            throw new Error('Tanda kutip konfigurasi belum ditutup.');
        }
        skip();
        if (text[index++] !== '{') throw new Error('Tempel objek firebaseConfig, mulai dari tanda { sampai }.');
        const result = Object.create(null);
        while (index < text.length) {
            skip();
            if (text[index] === '}') { index++; break; }
            let key;
            if (text[index] === '"' || text[index] === "'") key = quoted();
            else {
                const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(index));
                if (!match) throw new Error('Nama field konfigurasi tidak dikenali.');
                key = match[0]; index += key.length;
            }
            skip();
            if (text[index++] !== ':') throw new Error('Konfigurasi tidak lengkap setelah nama field.');
            skip();
            if (Object.hasOwn(result, key)) throw new Error(`Field ${key} ditulis dua kali.`);
            result[key] = quoted();
            skip();
            if (text[index] === ',') { index++; continue; }
            if (text[index] !== '}') throw new Error('Pisahkan field konfigurasi dengan koma.');
        }
        if (text[index - 1] !== '}') throw new Error('Objek konfigurasi belum ditutup dengan }.');
        if (!marker && !/^\s*;?\s*$/.test(text.slice(index))) throw new Error('Tempel hanya objek konfigurasi.');
        return normalize(result);
    }
    function resolve() {
        try {
            if (window.VALUTAX_FIREBASE_CONFIG) return { config: normalize(window.VALUTAX_FIREBASE_CONFIG), origin: 'file' };
            const raw = localStorage.getItem(storageKey);
            return raw ? { config: normalize(JSON.parse(raw)), origin: 'browser' } : { config: null, origin: null };
        } catch (error) { return { config: null, origin: null, error: error.message }; }
    }
    return { storageKey, normalize, parse, resolve };
})();
