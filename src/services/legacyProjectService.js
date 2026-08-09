/**
 * ============================================================
 * LEGACY_PROJECT_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Dipakai KHUSUS oleh frontend Project Estimator versi "port
 * langsung" dari app lama (ALUVE_Project_Estimator (10).html).
 *
 * KENAPA INI ADA: app lama itu 100% localStorage, satu file besar,
 * hasil trial-error berhari-hari — supaya tampilan & logic-nya TIDAK
 * BERUBAH SAMA SEKALI saat dipindah ke banyak user (Niken, Delvy,
 * dst), pendekatan yang dipakai adalah: biarkan objek "Project" di
 * app lama (camelCase, struktur lengkap items/aluminiumLines/dst)
 * disimpan APA ADANYA sebagai field `legacy_project_data` di
 * dokumen quotation — bukan dipetakan ulang ke skema quotation kita
 * yang snake_case. Field snake_case (client_name, dst) tetap
 * disinkronkan sebagai "ringkasan" supaya tetap kebaca dari
 * quotationService.js/Sales App/dashboard nanti.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, deleteDoc, queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateRequiredFields } = require('../lib/validator');

const COL = CONFIG.COLLECTIONS.QUOTATIONS;

/** Mengubah 1 dokumen Firestore jadi objek "Project" persis bentuk app lama. */
function toLegacyProject(doc) {
  if (doc.legacy_project_data) {
    // Sudah pernah disimpan lewat app ini — kembalikan apa adanya,
    // hanya pastikan projectId selalu sinkron dengan Firestore doc id.
    return Object.assign({}, doc.legacy_project_data, { projectId: doc.id });
  }
  // Belum pernah dibuka di app ini (misal quotation auto-dibuat oleh
  // Sales App saat Pipeline Stage jadi "Perlu Estimasi Harga") — susun
  // objek Project kosong dari field ringkasan yang sudah ada.
  return {
    projectId: doc.id,
    quotationNumber: doc.quotation_number || '',
    projectDate: (doc.created_at ? new Date(doc.created_at).toISOString() : new Date().toISOString()).slice(0, 10),
    clientName: doc.client_name || '',
    projectName: doc.project_name || '',
    location: doc.location || '',
    customerPhone: doc.customer_phone || '',
    salesRep: doc.sales_rep || '',
    leadSource: '', leadSourceOther: '',
    status: 'draft',
    createdAt: doc.created_at || new Date().toISOString(),
    updatedAt: doc.updated_at || new Date().toISOString(),
    items: Array.isArray(doc.items) ? doc.items : [],
    projectDiscount: doc.project_discount || { type: 'percent', value: 0 },
    _salesProjectId: doc.project_id || '' // dipakai frontend untuk tahu ini terhubung ke Sales App atau tidak
  };
}

/** Daftar seluruh "Project" (quotation) milik business_id user — dipetakan ke bentuk app lama. */
async function listLegacyProjects(env, user) {
  const rows = await queryDocs(env, COL, {
    where: [{ field: 'business_id', value: user.business_id }],
    orderBy: { field: 'updated_at', direction: 'desc' }
  });
  return successResponse(rows.map(toLegacyProject), rows.length + ' project ditemukan');
}

/**
 * Simpan (create atau overwrite) 1 Project persis struktur app lama.
 * `data.project` adalah objek Project APA ADANYA dari frontend
 * (camelCase, lengkap dengan items/aluminiumLines/dst).
 */
async function saveLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project']);
  const project = data.project;
  if (!project.projectId) throwError('projectId wajib ada di objek project', 'invalid-argument');

  const existing = await getDoc(env, COL, project.projectId);
  const now = new Date();

  const doc = {
    business_id: user.business_id,
    project_id: (existing && existing.project_id) || '', // link ke project Sales App, kalau ada — tidak pernah diubah dari sini
    quotation_number: project.quotationNumber || '',
    revision_number: (existing && existing.revision_number) || 1,
    client_name: project.clientName || '',
    project_name: project.projectName || '',
    location: project.location || '',
    customer_phone: project.customerPhone || '',
    sales_rep: project.salesRep || '',
    sales_uid: (existing && existing.sales_uid) || '',
    status: (existing && existing.status) || CONFIG.QUOTATION_STATUS.DRAFT,
    items: Array.isArray(project.items) ? project.items : [],
    project_discount: project.projectDiscount || { type: 'percent', value: 0 },
    legacy_project_data: project,
    created_by: (existing && existing.created_by) || user.uid,
    created_at: (existing && existing.created_at) || now,
    updated_at: now
  };

  await setDoc(env, COL, project.projectId, doc);
  return successResponse({ project_id: project.projectId }, 'Project berhasil disimpan');
}

async function deleteLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);
  await deleteDoc(env, COL, data.project_id);
  return successResponse({ project_id: data.project_id }, 'Project berhasil dihapus');
}

/**
 * Dipanggil saat status Project di app lama diubah jadi 'sent' DAN
 * project ini terhubung ke project Sales App (_salesProjectId ada) —
 * otomatis update balik Pipeline Stage jadi "Penawaran Siap", persis
 * seperti markQuotationComplete di quotationService.js.
 */
async function notifySalesQuotationSent(env, user, data) {
  validateRequiredFields(data, ['project_id']);
  const doc = await getDoc(env, COL, data.project_id);
  if (!doc || !doc.project_id) {
    return successResponse({ notified: false }, 'Project ini tidak terhubung ke Sales App — dilewati');
  }

  await setDoc(env, COL, data.project_id, Object.assign({}, doc, {
    status: CONFIG.QUOTATION_STATUS.SELESAI_DIHITUNG,
    updated_at: new Date()
  }));

  const { updateDoc } = require('../lib/firestoreRest');
  const project = await getDoc(env, CONFIG.COLLECTIONS.PROJECTS, doc.project_id);
  if (project) {
    const projectUpdates = {
      pipeline_stage: CONFIG.PIPELINE_STAGE.OFFER_READY,
      date_last_activity: new Date()
    };
    // Isi otomatis "Nilai Estimasi Project" dari Grand Total quotation
    // (dikirim frontend, sudah dihitung pakai Calculator yang sama persis
    // dipakai untuk export PDF/Excel) — sales tidak perlu ketik manual lagi
    // begitu quotation resmi dari Estimator sudah ada.
    if (typeof data.estimated_value === 'number' && Number.isFinite(data.estimated_value)) {
      projectUpdates.estimated_value = data.estimated_value;
    }
    await updateDoc(env, CONFIG.COLLECTIONS.PROJECTS, doc.project_id, projectUpdates);
  }

  return successResponse({ notified: true }, 'Sales App sudah diberi tahu quotation ini terkirim');
}

module.exports = { listLegacyProjects, saveLegacyProject, deleteLegacyProject, notifySalesQuotationSent };
