/**
 * ============================================================
 * PRICE_CATALOG_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Katalog harga master dipakai Project Estimator. 1 dokumen per
 * business_id (mirip pola lookupService.js), berisi struktur
 * brand_tiers -> groups -> items, plus glass/other/sealant.
 *
 * HANYA super_admin yang boleh EDIT (dicek di index.js lewat
 * `roles: ['super_admin']` pada route updatePriceCatalog) — sesuai
 * keputusan Anto. Semua role lain (estimator/manager) boleh BACA saja,
 * karena katalog ini dipakai untuk menyusun quotation.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, addDoc } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');

const COL = CONFIG.COLLECTIONS.PRICE_CATALOGS;
const HISTORY_COL = CONFIG.COLLECTIONS.PRICE_HISTORY;

/**
 * PATCH BUSINESS SWITCHER + KEAMANAN: sebelumnya business_id yang
 * dikirim di payload langsung dipakai apa adanya, TANPA dicek apakah
 * user memang berhak lihat/ubah data bisnis itu — siapa pun yang login
 * bisa saja isi business_id bisnis lain dan baca datanya. Sekarang
 * divalidasi dulu lewat resolveBusinessId (sama seperti di
 * legacyProjectService.js): boleh pindah bisnis HANYA kalau memang ada
 * di user.business_ids, atau dia super_admin.
 */
function resolveBusinessId(user, requestedBusinessId) {
  if (!requestedBusinessId) return user.business_id;
  if (requestedBusinessId === user.business_id) return requestedBusinessId;
  if (user.role === 'super_admin') return requestedBusinessId;
  if (Array.isArray(user.business_ids) && user.business_ids.includes(requestedBusinessId)) {
    return requestedBusinessId;
  }
  return user.business_id;
}

async function readPriceCatalog(env, user, data) {
  const businessId = resolveBusinessId(user, data.business_id);
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const doc = await getDoc(env, COL, businessId);
  if (!doc) {
    return successResponse(
      { brand_tiers: {}, glass: { items: [] }, other: { items: [] }, sealant: null },
      'Katalog harga untuk bisnis ini belum diatur'
    );
  }
  return successResponse(doc, 'Katalog harga berhasil dimuat');
}

/**
 * Menimpa seluruh katalog (frontend Price Manager mengirim struktur
 * penuh setelah diedit — bukan patch per-item, supaya tetap simpel),
 * dan mencatat 1 baris ke price_history sebagai jejak audit siapa
 * mengubah kapan (isi detail perubahan tidak dicatat baris-per-baris,
 * cukup ringkasan + siapa + kapan).
 */
async function updatePriceCatalog(env, user, data) {
  const businessId = resolveBusinessId(user, data.business_id);
  if (!businessId || !data.catalog) {
    throwError('business_id dan catalog wajib diisi', 'invalid-argument');
  }

  const catalogToSave = Object.assign({}, data.catalog);
  delete catalogToSave.id;

  await setDoc(env, COL, businessId, catalogToSave);

  await addDoc(env, HISTORY_COL, {
    business_id: businessId,
    changed_by: user.uid,
    changed_by_name: user.name || user.email || user.uid,
    change_summary: data.change_summary || 'Katalog harga diperbarui',
    changed_at: new Date()
  });

  return successResponse({ business_id: businessId }, 'Katalog harga berhasil diperbarui');
}

module.exports = { readPriceCatalog, updatePriceCatalog };
