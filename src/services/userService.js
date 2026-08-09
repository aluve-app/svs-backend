/**
 * ============================================================
 * USER_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * BARU — tidak ada versi Apps Script sebelumnya (dulu kelola akun
 * dilakukan manual lewat Firestore Console + script). Semua fungsi
 * di sini KHUSUS super_admin (dicek di index.js lewat `roles`).
 *
 * Membuat/menonaktifkan/menghapus akun memakai Identity Toolkit Admin
 * REST API (bagian dari Google Identity Platform) — endpoint resmi
 * yang sama yang dipakai firebase-admin SDK secara internal. Tidak
 * butuh SDK khusus, cukup access token OAuth2 yang sudah kita punya —
 * googleAuth.js memang sudah minta scope 'identitytoolkit' sejak awal
 * proyek ini, jadi tidak perlu setup kredensial baru.
 *
 * PENTING soal password: setiap akun baru diberi password SEMENTARA
 * yang di-generate acak oleh server, dan HANYA dikembalikan SATU KALI
 * di response saat itu juga (tidak pernah disimpan ke Firestore).
 * Anto salin manual lalu bagikan ke orangnya.
 *
 * AKSES MULTI-BISNIS: field `business_ids` (array) adalah daftar
 * bisnis yang boleh diakses akun ini. Field `business_id` (tunggal,
 * lama) TETAP disimpan sebagai bisnis utama/default = business_ids[0]
 * — supaya semua service LAIN yang masih baca `user.business_id`
 * langsung (project/activity/contact/photo/lookup/dsb, yang jumlahnya
 * banyak dan belum semua disentuh sesi ini) tetap jalan tanpa perlu
 * diubah satu-satu. Role `estimator` DIKUNCI cuma boleh akses "aluve"
 * (Estimator memang cuma ada untuk Aluve sejauh ini).
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, updateDoc, deleteDoc, queryDocs } = require('../lib/firestoreRest');
const { getGoogleAccessToken } = require('../lib/googleAuth');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateRequiredFields } = require('../lib/validator');

const USERS_COL = CONFIG.COLLECTIONS.USERS;
const VALID_ROLES = ['sales', 'estimator', 'manager', 'super_admin'];
const VALID_BUSINESS_IDS = Object.values(CONFIG.BUSINESS);

function generateTempPassword() {
  // 10 karakter acak (huruf besar/kecil/angka, tanpa karakter mirip
  // seperti 0/O atau l/1) — cukup kuat, tapi gampang diketik ulang manual.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

/**
 * Validasi & normalisasi daftar business_ids sesuai role.
 * - Role 'estimator' DIPAKSA jadi ['aluve'] apapun input-nya (Estimator
 *   belum ada untuk GBP).
 * - Role lain: minimal 1 bisnis, semua harus dikenal (aluve/gbp).
 */
function normalizeBusinessIds(role, businessIdsInput, fallbackSingle) {
  let ids = Array.isArray(businessIdsInput) && businessIdsInput.length > 0
    ? businessIdsInput
    : (fallbackSingle ? [fallbackSingle] : []);

  ids = [...new Set(ids)].filter(Boolean);

  if (role === 'estimator') return ['aluve'];

  if (ids.length === 0) throwError('Minimal 1 bisnis harus dipilih', 'invalid-argument');
  ids.forEach((id) => {
    if (!VALID_BUSINESS_IDS.includes(id)) throwError('business_id tidak valid: ' + id, 'invalid-argument');
  });
  return ids;
}

async function identityToolkitCall(env, path, body) {
  const serviceAccount = typeof env.FIREBASE_SERVICE_ACCOUNT === 'string'
    ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)
    : env.FIREBASE_SERVICE_ACCOUNT;
  const token = await getGoogleAccessToken(serviceAccount);

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (!res.ok) {
    const msg = (json.error && json.error.message) || 'Gagal menghubungi Identity Toolkit';
    throwError('Gagal memproses akun login: ' + msg, 'internal');
  }
  return json;
}

/**
 * @param {Object} data - { name, email, role, business_id, business_ids?, sales_code? }
 * `business_ids` (array) opsional — kalau tidak diisi, dianggap 1 bisnis
 * saja (business_id lama). Membuat akun Firebase Authentication BARU +
 * dokumen users di Firestore.
 */
async function createUserAccount(env, user, data) {
  validateRequiredFields(data, ['name', 'email', 'role', 'business_id']);

  if (!VALID_ROLES.includes(data.role)) {
    throwError('Role tidak valid: ' + data.role, 'invalid-argument');
  }
  const businessIds = normalizeBusinessIds(data.role, data.business_ids, data.business_id);

  // Cek cepat duplikat email di koleksi users (bukan pengganti validasi
  // resmi Identity Toolkit di bawah, sekadar pesan error yang lebih jelas)
  const existing = await queryDocs(env, USERS_COL, { where: [{ field: 'email', value: data.email }] });
  if (existing.length > 0) {
    throwError('Email ini sudah terdaftar sebagai akun user.', 'invalid-argument');
  }

  const tempPassword = generateTempPassword();

  const created = await identityToolkitCall(env, '/accounts', {
    email: data.email,
    password: tempPassword,
    displayName: data.name,
    disabled: false
  });

  const uid = created.localId;
  if (!uid) throwError('Gagal membuat akun — tidak ada UID dikembalikan.', 'internal');

  const now = new Date();
  const userDoc = {
    name: data.name,
    email: data.email,
    role: data.role,
    business_id: businessIds[0], // bisnis utama/default — dipakai semua service lama
    business_ids: businessIds,   // daftar lengkap bisnis yang boleh diakses
    sales_code: data.sales_code || '',
    status: 'Aktif',
    date_created: now,
    created_by: user.uid
  };

  await setDoc(env, USERS_COL, uid, userDoc);

  return successResponse(
    { uid, temp_password: tempPassword, ...userDoc },
    'Akun berhasil dibuat. SIMPAN/salin password sementara ini sekarang — tidak akan ditampilkan lagi setelah ini.'
  );
}

/** @param {Object} data - { business_id? } — kosongkan untuk lihat semua bisnis */
async function listUserAccounts(env, user, data) {
  const rows = await queryDocs(env, USERS_COL, { where: [] });
  let result = rows.map((r) => ({
    uid: r.id,
    ...r,
    business_ids: Array.isArray(r.business_ids) && r.business_ids.length > 0 ? r.business_ids : [r.business_id]
  }));

  // Filter di memori (bukan di query Firestore) karena business_ids array
  // butuh operator "array-contains" yang lebih ribet lewat REST — datanya
  // sedikit (puluhan akun), jadi filter di sini cukup cepat.
  if (data && data.business_id) {
    result = result.filter((r) => r.business_ids.includes(data.business_id));
  }

  result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return successResponse(result, result.length + ' akun ditemukan');
}

/** @param {Object} data - { uid, role?, business_id?, business_ids?, sales_code?, name? } */
async function updateUserRole(env, user, data) {
  validateRequiredFields(data, ['uid']);
  const existing = await getDoc(env, USERS_COL, data.uid);
  if (!existing) throwError('Akun tidak ditemukan', 'not-found');

  const updates = {};
  const nextRole = data.role || existing.role;
  if (data.role) {
    if (!VALID_ROLES.includes(data.role)) throwError('Role tidak valid: ' + data.role, 'invalid-argument');
    updates.role = data.role;
  }

  // Kalau role dan/atau business_ids ikut diubah, normalisasi ulang
  // (termasuk guard rail: role estimator dipaksa cuma "aluve")
  if (data.business_ids || data.business_id || data.role) {
    const inputIds = data.business_ids || (data.business_id ? [data.business_id] : existing.business_ids || [existing.business_id]);
    const businessIds = normalizeBusinessIds(nextRole, inputIds, existing.business_id);
    updates.business_id = businessIds[0];
    updates.business_ids = businessIds;
  }

  if (data.sales_code !== undefined) updates.sales_code = data.sales_code;
  if (data.name) updates.name = data.name;

  if (Object.keys(updates).length === 0) throwError('Tidak ada field yang diperbarui', 'invalid-argument');

  await updateDoc(env, USERS_COL, data.uid, updates);
  return successResponse({ uid: data.uid }, 'Akun berhasil diperbarui');
}

/**
 * @param {Object} data - { uid, status: 'Aktif'|'Nonaktif' }
 * Menonaktifkan akun JUGA mematikan login-nya langsung di Firebase Auth
 * (bukan cuma flag di Firestore) — supaya benar-benar tidak bisa login,
 * bukan cuma disembunyikan dari daftar Dashboard.
 */
async function setUserStatus(env, user, data) {
  validateRequiredFields(data, ['uid', 'status']);
  if (!['Aktif', 'Nonaktif'].includes(data.status)) {
    throwError('status harus "Aktif" atau "Nonaktif"', 'invalid-argument');
  }
  if (data.uid === user.uid) {
    throwError('Tidak bisa menonaktifkan akun sendiri.', 'invalid-argument');
  }

  const existing = await getDoc(env, USERS_COL, data.uid);
  if (!existing) throwError('Akun tidak ditemukan', 'not-found');

  await identityToolkitCall(env, '/accounts:update', {
    localId: data.uid,
    disableUser: data.status === 'Nonaktif'
  });

  await updateDoc(env, USERS_COL, data.uid, { status: data.status });
  return successResponse({ uid: data.uid, status: data.status }, 'Status akun berhasil diperbarui');
}

/**
 * Reset password ke password sementara BARU (kalau user lupa password).
 * Sama seperti createUserAccount, password dikembalikan SATU KALI saja.
 */
async function resetUserPassword(env, user, data) {
  validateRequiredFields(data, ['uid']);
  const existing = await getDoc(env, USERS_COL, data.uid);
  if (!existing) throwError('Akun tidak ditemukan', 'not-found');

  const tempPassword = generateTempPassword();
  await identityToolkitCall(env, '/accounts:update', {
    localId: data.uid,
    password: tempPassword
  });

  return successResponse(
    { uid: data.uid, temp_password: tempPassword },
    'Password sementara baru berhasil dibuat. SIMPAN sekarang — tidak ditampilkan lagi setelah ini.'
  );
}

/**
 * Hapus akun PERMANEN — baik dari Firebase Authentication (tidak bisa
 * login lagi sama sekali) maupun dokumennya di Firestore. TIDAK BISA
 * DIBATALKAN. Project/activity yang pernah dibuat akun ini TETAP ada
 * (tidak ikut terhapus) — cuma akun login-nya yang hilang, supaya
 * histori data tidak rusak.
 */
async function deleteUserAccount(env, user, data) {
  validateRequiredFields(data, ['uid']);
  if (data.uid === user.uid) {
    throwError('Tidak bisa menghapus akun sendiri.', 'invalid-argument');
  }

  const existing = await getDoc(env, USERS_COL, data.uid);
  if (!existing) throwError('Akun tidak ditemukan', 'not-found');

  await identityToolkitCall(env, '/accounts:delete', { localId: data.uid });
  await deleteDoc(env, USERS_COL, data.uid);

  return successResponse({ uid: data.uid }, 'Akun berhasil dihapus permanen');
}

module.exports = {
  createUserAccount, listUserAccounts, updateUserRole, setUserStatus, resetUserPassword, deleteUserAccount
};
