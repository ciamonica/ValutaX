'use strict';
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('firebaseConfigInput');
    const status = document.getElementById('setupStatus');
    const result = document.getElementById('connectionResult');
    const active = window.ValutaXConfig.resolve();
    if (active.config) {
        input.value = JSON.stringify(active.config, null, 2);
        status.textContent = `Proyek aktif: ${active.config.projectId}. Sumber: ${active.origin === 'file' ? 'file proyek' : 'pengaturan browser'}.`;
    } else status.textContent = active.error || 'Belum ada proyek terhubung. Ikuti langkah 1, lalu tempel konfigurasinya.';
    function show(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
    function getConfig() { return window.ValutaXConfig.parse(input.value); }
    document.getElementById('saveConfigBtn').addEventListener('click', () => {
        try {
            const config = getConfig();
            if (active.origin === 'file' && JSON.stringify(config) !== JSON.stringify(active.config)) {
                show('File proyek sudah menentukan konfigurasi. Unduh konfigurasi baru dan ganti firebase-config.js terlebih dahulu.', true);
                return;
            }
            localStorage.setItem(window.ValutaXConfig.storageKey, JSON.stringify(config));
            show(`Pengaturan ${config.projectId} tersimpan pada browser ini. Lanjutkan Uji koneksi Firebase.`);
        } catch (error) { show(error.message || 'Pengaturan belum dapat disimpan.', true); }
    });
    document.getElementById('downloadConfigBtn').addEventListener('click', () => {
        try {
            const content = '// Konfigurasi aplikasi Web ValutaX. Jangan menaruh password atau private key di sini.\n' +
                'window.VALUTAX_FIREBASE_CONFIG = ' + JSON.stringify(getConfig(), null, 2) + ';\n';
            const url = URL.createObjectURL(new Blob([content], { type: 'text/javascript' }));
            const link = document.createElement('a'); link.href = url; link.download = 'firebase-config.js'; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            show('Konfigurasi diunduh. Ganti firebase-config.js dalam folder aplikasi, lalu muat ulang.');
        } catch (error) { show(error.message, true); }
    });
    document.getElementById('testConnectionBtn').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        result.classList.remove('error');
        result.textContent = 'Memeriksa sesi anonim dan akses database…';
        try {
            const config = getConfig();
            if (!navigator.onLine) throw new Error('Perangkat offline. Nyalakan internet untuk menguji Firebase.');
            const client = new window.FirebaseHistoryClient(config);
            await client.readHistory(1);
            result.textContent = `Berhasil membaca Firestore proyek ${config.projectId}. Simpan pengaturan lalu buka aplikasi untuk menguji penyimpanan konversi.`;
        } catch (error) {
            result.classList.add('error');
            const message = error.message || '';
            result.textContent = /OPERATION_NOT_ALLOWED/.test(message) ? 'Anonymous belum aktif. Aktifkan di Authentication → Sign-in method.' :
                error.status === 403 ? 'Izin database ditolak. Periksa firestore.rules dan pembatasan API key.' :
                error.status === 404 ? 'Database (default) belum ditemukan. Buat Cloud Firestore pada proyek yang sama.' :
                /SESSION_/.test(message) ? 'Sesi anonim tidak valid atau berubah. Pertahankan data situs dan baca bagian pemulihan pada panduan.' :
                `Belum berhasil: ${message || 'layanan tidak dapat diakses'}. Periksa konfigurasi dan koneksi.`;
        } finally { button.disabled = false; }
    });
});
