/**
 * ============================================================
 * CONFIG.JS
 * ============================================================
 * Pengganti Config.gs dari versi lama.
 * Semua konstanta yang mungkin berubah (batas hari Health_Status,
 * nama koleksi Firestore, nama tahap Pipeline Stage yang jadi
 * "pemicu" logic tertentu) disimpan DI SATU TEMPAT ini saja.
 *
 * Kalau nanti ada nama tahap yang mau diganti (misal "Perlu Estimasi
 * Harga" mau diubah jadi nama lain), CUKUP ubah di sini — tidak perlu
 * bongkar file lain.
 * ============================================================
 */

const CONFIG = {
  // Nama koleksi Firestore
  COLLECTIONS: {
    USERS: 'users',
    PROJECTS: 'projects',
    ACTIVITIES: 'activities',
    PHOTOS: 'photos',
    CONTACTS: 'contacts',
    PROJECT_CONTACTS: 'project_contacts',
    LOOKUPS: 'lookups',
    ERROR_LOG: 'error_log'
  },

  // Kode bisnis yang didukung aplikasi ini
  BUSINESS: {
    ALUVE: 'aluve',
    GBP: 'gbp'
  },

  // Batas hari untuk menentukan Health_Status (sama seperti versi lama)
  HEALTH_STATUS: {
    ACTIVE_DAYS: 14,
    WARNING_DAYS: 30
  },

  // Nama-nama Pipeline_Stage yang jadi "pemicu" logic tertentu di kode
  // (bukan sekadar teks dropdown biasa). Kalau nanti nama-nama ini
  // di-rename lewat halaman Admin, UBAH JUGA nilainya di sini supaya
  // logic tetap nyambung.
  PIPELINE_STAGE: {
    NEW_VISIT: 'New Visit',   // stage awal otomatis saat project baru dibuat
    WON: 'Won',
    LOST: 'Lost',
    NEEDS_ESTIMATION: 'Perlu Estimasi Harga', // trigger kirim ke Estimator
    OFFER_READY: 'Penawaran Siap'             // tahap perantara, perlu konfirmasi manual sales
  },

  API_VERSION: '2.0.0-firebase'
};

module.exports = { CONFIG };
