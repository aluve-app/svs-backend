/**
 * ============================================================
 * VALIDATOR.JS
 * ============================================================
 * Pengganti Validator.gs. Aturan-aturan wajib SAMA dengan versi
 * lama, HANYA field sales_code/token dihapus dari daftar wajib
 * karena sekarang identitas sales datang otomatis dari Firebase
 * Authentication (context.auth.uid), bukan dikirim manual di payload.
 * ============================================================
 */

const { throwError } = require('./responseHelper');

function validateRequiredFields(data, requiredFields) {
  const missing = [];
  requiredFields.forEach((field) => {
    const value = data[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.push(field);
    }
  });
  if (missing.length > 0) {
    throwError('Field wajib belum diisi: ' + missing.join(', '), 'invalid-argument');
  }
}

function validateCreateProject(data) {
  validateRequiredFields(data, ['project_name', 'location_address', 'product_type']);
}

function validateUpdateProject(data) {
  validateRequiredFields(data, ['project_id']);
}

function validateCreateActivity(data) {
  validateRequiredFields(data, [
    'project_id',
    'activity_type',
    'activity_note',
    'pipeline_stage',
    'next_followup_date'
  ]);

  if (data.pipeline_stage === 'Lost' && !data.lost_reason) {
    throwError('Alasan Lost wajib diisi ketika status project diubah menjadi Lost', 'invalid-argument');
  }
}

function validateUploadPhoto(data) {
  validateRequiredFields(data, ['project_id', 'file_base64', 'mime_type']);
}

function validateCreateContact(data) {
  validateRequiredFields(data, ['project_id', 'contact_name', 'phone_number', 'role']);
}

/**
 * Validasi payload saveQuotation (dipanggil berkali-kali sebagai
 * autosave selama Estimator kerja) — cuma quotation_id yang wajib,
 * item-item boleh masih kosong (draft belum selesai). Validasi
 * "harus ada minimal 1 item" baru diperiksa saat markQuotationComplete.
 */
function validateSaveQuotationItems(data) {
  validateRequiredFields(data, ['quotation_id']);
  if (data.items !== undefined && !Array.isArray(data.items)) {
    throwError('items harus berupa array', 'invalid-argument');
  }
}

module.exports = {
  validateRequiredFields,
  validateCreateProject,
  validateUpdateProject,
  validateCreateActivity,
  validateUploadPhoto,
  validateCreateContact,
  validateSaveQuotationItems
};
