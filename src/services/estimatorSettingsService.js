/**
 * ============================================================
 * ESTIMATOR_SETTINGS_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Pengaturan letterhead/export per bisnis (nama perusahaan, alamat,
 * rekening, syarat pembayaran, T&C) — dipakai saat Export PDF/Excel
 * di Project Estimator. 1 dokumen per business_id, supaya Aluve &
 * GBP nanti bisa punya identitas surat penawaran yang beda total.
 *
 * Sama seperti katalog harga, HANYA super_admin yang boleh EDIT
 * (dicek di index.js).
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');

const COL = CONFIG.COLLECTIONS.ESTIMATOR_SETTINGS;

const DEFAULT_SETTINGS = {
  company_name: '',
  company_address: '',
  company_phone: '',
  logo_url: '',
  bank_account_info: '',
  payment_terms: '',
  quotation_validity_days: 14,
  terms_and_conditions: ''
};

/** Sama seperti resolveBusinessId di legacyProjectService.js / priceCatalogService.js — lihat komentar di sana. */
function resolveBusinessId(user, requestedBusinessId) {
  if (!requestedBusinessId) return user.business_id;
  if (requestedBusinessId === user.business_id) return requestedBusinessId;
  if (user.role === 'super_admin') return requestedBusinessId;
  if (Array.isArray(user.business_ids) && user.business_ids.includes(requestedBusinessId)) {
    return requestedBusinessId;
  }
  return user.business_id;
}

async function readEstimatorSettings(env, user, data) {
  const businessId = resolveBusinessId(user, data.business_id);
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const doc = await getDoc(env, COL, businessId);
  return successResponse(Object.assign({}, DEFAULT_SETTINGS, doc || {}), 'Pengaturan Estimator berhasil dimuat');
}

async function updateEstimatorSettings(env, user, data) {
  const businessId = resolveBusinessId(user, data.business_id);
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const existing = (await getDoc(env, COL, businessId)) || {};
  delete existing.id;
  const merged = Object.assign({}, DEFAULT_SETTINGS, existing, data.settings || {});

  await setDoc(env, COL, businessId, merged);
  return successResponse(merged, 'Pengaturan Estimator berhasil disimpan');
}

module.exports = { readEstimatorSettings, updateEstimatorSettings };
