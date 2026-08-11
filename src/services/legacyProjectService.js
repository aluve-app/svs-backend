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
 *
 * FITUR SAMPAH (soft-delete) — ditambahkan supaya konsisten dengan
 * pola yang sudah dipakai di project Sales App (projectService.js):
 * field `is_deleted`/`deleted_at`/`deleted_by` di level dokumen
 * quotation (BUKAN di dalam legacy_project_data, supaya tidak ikut
 * campur dengan struktur app lama yang harus tetap apa adanya).
 * "Hapus" dari Estimator sekarang otomatis jadi soft-delete — quotation
 * dipindah ke Sampah (bisa dilihat & dikelola dari Manager Dashboard →
 * Admin Console → Kelola Project → Sampah, bareng dengan Sampah project
 * Sales App), BUKAN langsung hilang permanen seperti sebelumnya.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, updateDoc, deleteDoc, queryDocs } = require('../lib/firestoreRest');
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

/**
 * Daftar seluruh "Project" (quotation) milik business_id user — dipetakan
 * ke bentuk app lama. Quotation yang sudah di-soft-delete (is_deleted=true)
 * TIDAK ikut muncul di sini — sama seperti project Sales App yang sudah
 * dihapus tidak muncul di Sales App/Dashboard manapun.
 */
async function listLegacyProjects(env, user) {
  const rows = await queryDocs(env, COL, {
    where: [{ field: 'business_id', value: user.business_id }],
    orderBy: { field: 'updated_at', direction: 'desc' }
  });
  const visible = rows.filter((r) => !r.is_deleted);
  return successResponse(visible.map(toLegacyProject), visible.length + ' project ditemukan');
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
    updated_at: now,
    // Field Sampah dipertahankan apa adanya kalau sudah ada (jaga-jaga
    // kalau suatu saat ada alur simpan ulang ke quotation yang statusnya
    // sedang di Sampah — seharusnya tidak terjadi dari UI normal, tapi
    // aman kalau tetap dijaga di sini).
    is_deleted: (existing && existing.is_deleted) || false,
    deleted_at: (existing && existing.deleted_at) || null,
    deleted_by: (existing && existing.deleted_by) || null
  };

  await setDoc(env, COL, project.projectId, doc);
  return successResponse({ project_id: project.projectId }, 'Project berhasil disimpan');
}

/**
 * Hapus quotation (SOFT DELETE) — dipindah ke Sampah, TIDAK langsung
 * hilang dari Firestore. Sama seperti deleteProject di Sales App.
 */
async function deleteLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');

  await updateDoc(env, COL, data.project_id, {
    is_deleted: true,
    deleted_at: new Date(),
    deleted_by: user.uid
  });

  return successResponse({ project_id: data.project_id }, 'Project dipindahkan ke Sampah');
}

/**
 * Pulihkan quotation dari Sampah. Khusus super_admin (dicek di index.js) —
 * dikelola dari Manager Dashboard, bukan dari Estimator sendiri (Estimator
 * belum punya halaman Sampah-nya sendiri).
 */
async function restoreLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  if (!existing.is_deleted) throwError('Project ini tidak sedang berada di Sampah', 'invalid-argument');

  await updateDoc(env, COL, data.project_id, {
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    restored_at: new Date(),
    restored_by: user.uid
  });

  return successResponse({ project_id: data.project_id }, 'Project berhasil dipulihkan dari Sampah');
}

/**
 * Hapus quotation PERMANEN dari Firestore — TIDAK BISA DIBATALKAN. Hanya
 * bisa dilakukan pada quotation yang SUDAH ada di Sampah. Khusus super_admin.
 * TIDAK ada cascading delete (quotation tidak punya sub-koleksi terpisah
 * seperti project Sales App — semua datanya menyatu di 1 dokumen lewat
 * legacy_project_data), jadi cukup hapus 1 dokumen ini saja.
 */
async function permanentlyDeleteLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  if (!existing.is_deleted) throwError('Project harus dipindahkan ke Sampah dulu sebelum dihapus permanen', 'invalid-argument');

  await deleteDoc(env, COL, data.project_id);
  return successResponse({ project_id: data.project_id }, 'Project dihapus permanen');
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

module.exports = {
  listLegacyProjects, saveLegacyProject, deleteLegacyProject,
  restoreLegacyProject, permanentlyDeleteLegacyProject, notifySalesQuotationSent
};
