/**
 * ============================================================
 * QUOTATION_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * "Quotation" = dokumen penawaran harga yang dibuat tim Estimator.
 * INI BEDA dari "Project" di Sales App (yang itu = data lead/
 * kunjungan) — sengaja dipakai istilah berbeda supaya tidak ketuker.
 *
 * 1 project Sales boleh punya BANYAK quotation (revisi harga/nego
 * ulang) — dibedakan lewat quotation_number + revision_number.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, updateDoc, queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateRequiredFields, validateSaveQuotationItems } = require('../lib/validator');
const { generateQuotationId, generateUniqueId } = require('../lib/idGenerator');

const QUO_COL = CONFIG.COLLECTIONS.QUOTATIONS;
const PROJ_COL = CONFIG.COLLECTIONS.PROJECTS;

/**
 * Dipanggil INTERNAL oleh activityService.js saat Pipeline Stage
 * project diubah jadi "Perlu Estimasi Harga" — BUKAN endpoint HTTP
 * sendiri. Membuat quotation baru terisi otomatis dari data project,
 * supaya tim Estimator tidak input ulang dari nol. Kalau project ini
 * sudah pernah punya quotation sebelumnya (revisi ke-2, ke-3, dst),
 * revision_number otomatis naik.
 *
 * @param {Object} env
 * @param {Object} project - dokumen project (sudah termasuk field project_id lewat pemanggil)
 * @param {string} projectId
 * @return {Promise<string>} quotationId yang baru dibuat
 */
async function createQuotationFromProject(env, project, projectId) {
  const existingQuotations = await queryDocs(env, QUO_COL, {
    where: [{ field: 'project_id', value: projectId }]
  });

  const nextRevision = existingQuotations.length > 0
    ? Math.max(...existingQuotations.map((q) => q.revision_number || 1)) + 1
    : 1;

  const quotationId = await generateUniqueId(generateQuotationId, env, QUO_COL);
  const now = new Date();

  const newQuotation = {
    business_id: project.business_id,
    project_id: projectId,
    quotation_number: quotationId,
    revision_number: nextRevision,
    client_name: project.project_name || '',
    project_name: project.project_name || '',
    location: project.location_address || '',
    customer_phone: '',
    sales_uid: project.sales_uid || '',
    sales_rep: project.sales_code || '',
    status: CONFIG.QUOTATION_STATUS.DRAFT,
    items: [],
    project_discount: { type: 'percent', value: 0 },
    notes: '',
    created_by: '',
    created_at: now,
    updated_at: now
  };

  await setDoc(env, QUO_COL, quotationId, newQuotation);
  return quotationId;
}

/**
 * Antrian quotation untuk tim Estimator. Default menampilkan semua
 * status (frontend yang memilah tab "Perlu Dikerjakan" vs "Selesai"),
 * bisa difilter status tertentu lewat data.status.
 */
async function listQuotationQueue(env, user, data) {
  const businessId = data.business_id || user.business_id;
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const where = [{ field: 'business_id', value: businessId }];
  if (data.status) where.push({ field: 'status', value: data.status });

  const rows = await queryDocs(env, QUO_COL, {
    where,
    orderBy: { field: 'created_at', direction: 'desc' }
  });
  return successResponse(rows, rows.length + ' quotation ditemukan');
}

async function readQuotation(env, user, data) {
  validateRequiredFields(data, ['quotation_id']);
  const doc = await getDoc(env, QUO_COL, data.quotation_id);
  if (!doc) throwError('Quotation tidak ditemukan: ' + data.quotation_id, 'not-found');
  return successResponse(doc, 'Detail quotation ditemukan');
}

/**
 * Simpan meta + item-item quotation. Dipanggil berkali-kali selama
 * Estimator bekerja (autosave) — TIDAK memvalidasi kelengkapan item,
 * itu tugas Calculator/Validation di sisi frontend sebelum export.
 */
async function saveQuotation(env, user, data) {
  validateSaveQuotationItems(data);

  const existing = await getDoc(env, QUO_COL, data.quotation_id);
  if (!existing) throwError('Quotation tidak ditemukan: ' + data.quotation_id, 'not-found');

  const updatableFields = [
    'client_name', 'project_name', 'location', 'customer_phone', 'sales_rep',
    'items', 'project_discount', 'notes'
  ];
  const updates = {};
  updatableFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) updates[field] = data[field];
  });
  updates.updated_at = new Date();
  if (!existing.created_by) updates.created_by = user.uid;

  await updateDoc(env, QUO_COL, data.quotation_id, updates);
  return successResponse({ quotation_id: data.quotation_id }, 'Quotation berhasil disimpan');
}

/**
 * Estimator menekan "Selesai Dihitung" — kunci status quotation, DAN
 * otomatis update balik Pipeline Stage project Sales App jadi
 * "Penawaran Siap" (tahap perantara — sales masih harus konfirmasi
 * manual setelah benar-benar mengirim ke klien, lewat Catat Aktivitas
 * di Sales App seperti biasa).
 */
async function markQuotationComplete(env, user, data) {
  validateRequiredFields(data, ['quotation_id']);

  const quotation = await getDoc(env, QUO_COL, data.quotation_id);
  if (!quotation) throwError('Quotation tidak ditemukan: ' + data.quotation_id, 'not-found');

  if (!Array.isArray(quotation.items) || quotation.items.length === 0) {
    throwError('Quotation belum punya item — tidak bisa ditandai selesai', 'invalid-argument');
  }

  await updateDoc(env, QUO_COL, data.quotation_id, {
    status: CONFIG.QUOTATION_STATUS.SELESAI_DIHITUNG,
    updated_at: new Date()
  });

  if (quotation.project_id) {
    const project = await getDoc(env, PROJ_COL, quotation.project_id);
    if (project) {
      await updateDoc(env, PROJ_COL, quotation.project_id, {
        pipeline_stage: CONFIG.PIPELINE_STAGE.OFFER_READY,
        date_last_activity: new Date()
      });
    }
  }

  return successResponse(
    { quotation_id: data.quotation_id },
    'Quotation ditandai selesai dihitung — Sales App sudah diperbarui ke "Penawaran Siap"'
  );
}

/**
 * Membuat quotation TANPA lewat project Sales App — misal untuk
 * klien walk-in yang belum tercatat di Sales App sama sekali.
 */
async function createManualQuotation(env, user, data) {
  validateRequiredFields(data, ['client_name']);

  const quotationId = await generateUniqueId(generateQuotationId, env, QUO_COL);
  const now = new Date();

  const newQuotation = {
    business_id: user.business_id,
    project_id: '',
    quotation_number: quotationId,
    revision_number: 1,
    client_name: data.client_name,
    project_name: data.project_name || data.client_name,
    location: data.location || '',
    customer_phone: data.customer_phone || '',
    sales_uid: '',
    sales_rep: data.sales_rep || '',
    status: CONFIG.QUOTATION_STATUS.DRAFT,
    items: [],
    project_discount: { type: 'percent', value: 0 },
    notes: '',
    created_by: user.uid,
    created_at: now,
    updated_at: now
  };

  await setDoc(env, QUO_COL, quotationId, newQuotation);
  return successResponse({ quotation_id: quotationId }, 'Quotation baru berhasil dibuat');
}

module.exports = {
  createQuotationFromProject,
  listQuotationQueue,
  readQuotation,
  saveQuotation,
  markQuotationComplete,
  createManualQuotation
};
