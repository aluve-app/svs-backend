/**
 * ============================================================
 * ESTIMATOR_SETTINGS_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Pengaturan letterhead/export per bisnis (nama perusahaan, alamat,
 * rekening, syarat pembayaran, T&C, logo) — dipakai saat Export
 * PDF/Excel di Project Estimator. 1 dokumen per business_id, supaya
 * Aluve & GBP nanti bisa punya identitas surat penawaran yang beda
 * total.
 *
 * Sama seperti katalog harga, HANYA super_admin yang boleh EDIT
 * (dicek di index.js).
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { uploadToCloudinary } = require('../lib/cloudinaryUpload');

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

async function readEstimatorSettings(env, user, data) {
  const businessId = data.business_id || user.business_id;
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const doc = await getDoc(env, COL, businessId);
  return successResponse(Object.assign({}, DEFAULT_SETTINGS, doc || {}), 'Pengaturan Estimator berhasil dimuat');
}

async function updateEstimatorSettings(env, user, data) {
  const businessId = data.business_id || user.business_id;
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const existing = (await getDoc(env, COL, businessId)) || {};
  delete existing.id;
  const merged = Object.assign({}, DEFAULT_SETTINGS, existing, data.settings || {});

  await setDoc(env, COL, businessId, merged);
  return successResponse(merged, 'Pengaturan Estimator berhasil disimpan');
}

/**
 * Upload logo perusahaan ke Cloudinary lalu simpan URL-nya ke field
 * logo_url. publicId TETAP (logo_<business_id>) supaya upload ulang
 * OTOMATIS MENIMPA logo lama di Cloudinary (tidak menumpuk file baru
 * tiap kali ganti logo).
 * @param {Object} data - { business_id?, file_base64, mime_type }
 */
async function uploadEstimatorLogo(env, user, data) {
  if (!data.file_base64 || !data.mime_type) {
    throwError('file_base64 dan mime_type wajib diisi', 'invalid-argument');
  }
  const businessId = data.business_id || user.business_id;
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  let uploadResult;
  try {
    uploadResult = await uploadToCloudinary(env, data.file_base64, data.mime_type, {
      publicId: 'logo_' + businessId,
      folder: 'svs_settings/' + businessId
    });
  } catch (err) {
    throwError('Gagal upload logo ke Cloudinary: ' + err.message, 'internal');
  }

  const existing = (await getDoc(env, COL, businessId)) || {};
  delete existing.id;
  const merged = Object.assign({}, DEFAULT_SETTINGS, existing, { logo_url: uploadResult.secure_url });

  await setDoc(env, COL, businessId, merged);
  return successResponse({ logo_url: uploadResult.secure_url }, 'Logo berhasil diunggah');
}

module.exports = { readEstimatorSettings, updateEstimatorSettings, uploadEstimatorLogo };
