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
 * FITUR SAMPAH: soft-delete (isDeleted/deletedAt) disimpan DI DALAM
 * legacy_project_data (project.js/trashPage.js Estimator yang atur),
 * jadi otomatis tersimpan lewat saveLegacyProject tanpa endpoint
 * khusus. deleteLegacyProject TETAP hapus permanen (dipanggil dari
 * tombol "Hapus Permanen" di halaman Sampah Estimator sendiri).
 * restoreLegacyProjectAdmin/permanentlyDeleteLegacyProjectAdmin di
 * bawah adalah tambahan KHUSUS supaya Manager Dashboard juga bisa
 * kelola Sampah quotation dari luar Estimator (super_admin only) —
 * baca/tulis field yang SAMA PERSIS, satu sumber data.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, updateDoc, deleteDoc, queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateRequiredFields } = require('../lib/validator');

const COL = CONFIG.COLLECTIONS.QUOTATIONS;

/**
 * PATCH BUSINESS SWITCHER: akun yang punya akses ke lebih dari 1 bisnis
 * (business_ids: ["gbp","aluve"]) boleh pindah lihat data bisnis lain di
 * Project Estimator lewat parameter business_id di request — tapi HANYA
 * kalau memang berhak (ada di business_ids, atau super_admin). Kalau
 * tidak berhak/tidak dikirim, diam-diam fallback ke bisnis utama akun.
 */
function resolveBusinessId(user, requestedBusinessId) {
  if (!requestedBusinessId) return user.business_id;
  if (requestedBusinessId === user.business_id) return requestedBusinessId;
  if (user.role === 'super_admin') return requestedBusinessId;
  if (Array.isArray(user.business_ids) && user.business_ids.includes(requestedBusinessId)) {
    return requestedBusinessId;
  }
  return user.business_id; // tidak berhak — diam-diam fallback, tidak error
}

/** Mengubah 1 dokumen Firestore jadi objek "Project" persis bentuk app lama. */
function toLegacyProject(doc) {
  const revisionOverlay = {
    revisionNumber: doc.revision_number || 1,
    isLocked: !!doc.is_locked,
    rootProjectId: doc.root_project_id || doc.id
  };

  if (doc.legacy_project_data) {
    return Object.assign({}, doc.legacy_project_data, { projectId: doc.id }, revisionOverlay);
  }
  return Object.assign({
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
    isDeleted: false,
    deletedAt: null,
    _salesProjectId: doc.project_id || ''
  }, revisionOverlay);
}

/**
 * Daftar seluruh "Project" (quotation) milik business_id user. Quotation
 * yang sudah di-soft-delete (legacy_project_data.isDeleted=true) TIDAK
 * ikut muncul di sini.
 */
async function listLegacyProjects(env, user, data) {
  const businessId = resolveBusinessId(user, data && data.business_id);
  const rows = await queryDocs(env, COL, {
    where: [{ field: 'business_id', value: businessId }],
    orderBy: { field: 'updated_at', direction: 'desc' }
  });
  const visible = rows.filter((r) => !(r.legacy_project_data && r.legacy_project_data.isDeleted));
  return successResponse(visible.map(toLegacyProject), visible.length + ' project ditemukan');
}

/**
 * Simpan (create atau overwrite) 1 Project persis struktur app lama —
 * TERMASUK flag isDeleted/deletedAt kalau memang sedang di-set/di-unset
 * lewat alur Hapus/Pulihkan di project.js (Storage.saveProject).
 */
async function saveLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project']);
  const project = data.project;
  if (!project.projectId) throwError('projectId wajib ada di objek project', 'invalid-argument');

  const existing = await getDoc(env, COL, project.projectId);
  if (existing && existing.is_locked) {
    throwError('Quotation ini sudah dikunci (revisi lama) — tidak bisa diedit lagi. Buka revisi terbaru untuk melanjutkan.', 'failed-precondition');
  }

  const now = new Date();
  const businessId = existing ? existing.business_id : resolveBusinessId(user, data.business_id);

  const doc = {
    business_id: businessId,
    project_id: (existing && existing.project_id) || '',
    quotation_number: project.quotationNumber || '',
    revision_number: (existing && existing.revision_number) || 1,
    root_project_id: (existing && existing.root_project_id) || project.projectId,
    is_locked: false,
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

/**
 * FITUR REVISI: bikin SALINAN quotation ini sebagai dokumen BARU (revisi
 * berikutnya), lalu KUNCI dokumen lama (is_locked: true) supaya tidak
 * bisa diedit lagi — jadi berfungsi sebagai riwayat/history permanen.
 */
async function createQuotationRevision(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const source = await getDoc(env, COL, data.project_id);
  if (!source) throwError('Quotation tidak ditemukan: ' + data.project_id, 'not-found');

  const { generateQuotationId, generateUniqueId } = require('../lib/idGenerator');
  const newId = await generateUniqueId(generateQuotationId, env, COL);
  const now = new Date();

  const rootProjectId = source.root_project_id || source.id;
  const newRevisionNumber = (source.revision_number || 1) + 1;

  const newLegacyData = Object.assign({}, source.legacy_project_data, {
    projectId: newId,
    status: 'draft'
  });

  const newDoc = {
    business_id: source.business_id,
    project_id: source.project_id || '',
    quotation_number: source.quotation_number || '',
    revision_number: newRevisionNumber,
    root_project_id: rootProjectId,
    is_locked: false,
    client_name: source.client_name || '',
    project_name: source.project_name || '',
    location: source.location || '',
    customer_phone: source.customer_phone || '',
    sales_rep: source.sales_rep || '',
    sales_uid: source.sales_uid || '',
    status: CONFIG.QUOTATION_STATUS.DRAFT,
    items: source.items || [],
    project_discount: source.project_discount || { type: 'percent', value: 0 },
    legacy_project_data: newLegacyData,
    created_by: user.uid,
    created_at: now,
    updated_at: now
  };

  await setDoc(env, COL, newId, newDoc);

  await setDoc(env, COL, data.project_id, Object.assign({}, source, {
    is_locked: true,
    root_project_id: rootProjectId,
    updated_at: now
  }));

  return successResponse(
    { project_id: newId, revision_number: newRevisionNumber },
    'Revisi ' + newRevisionNumber + ' berhasil dibuat. Revisi sebelumnya dikunci sebagai riwayat.'
  );
}

/**
 * Hapus PERMANEN & SUNGGUHAN dari Firestore — dipanggil dari tombol
 * "Hapus Permanen" di halaman Sampah Estimator sendiri, SETELAH project
 * sudah isDeleted. Soft-delete (masuk Sampah) terjadi lewat
 * saveLegacyProject di atas, BUKAN lewat endpoint ini.
 */
async function deleteLegacyProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);
  await deleteDoc(env, COL, data.project_id);
  return successResponse({ project_id: data.project_id }, 'Project berhasil dihapus');
}

/**
 * KHUSUS Manager Dashboard (Kelola Project → Sampah → tab Quotation) —
 * pulihkan quotation dari Sampah TANPA lewat Estimator. Baca/tulis field
 * yang SAMA PERSIS dipakai Estimator sendiri (legacy_project_data.
 * isDeleted/deletedAt), supaya sumber datanya tetap satu.
 */
async function restoreLegacyProjectAdmin(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Quotation tidak ditemukan: ' + data.project_id, 'not-found');
  if (!existing.legacy_project_data || !existing.legacy_project_data.isDeleted) {
    throwError('Quotation ini tidak sedang berada di Sampah', 'invalid-argument');
  }

  const updatedLegacyData = Object.assign({}, existing.legacy_project_data, {
    isDeleted: false,
    deletedAt: null
  });

  await updateDoc(env, COL, data.project_id, {
    legacy_project_data: updatedLegacyData,
    updated_at: new Date()
  });

  return successResponse({ project_id: data.project_id }, 'Quotation berhasil dipulihkan dari Sampah');
}

/**
 * KHUSUS Manager Dashboard — hapus permanen quotation dari Sampah TANPA
 * lewat Estimator. Nama endpoint terpisah dari deleteLegacyProject biasa
 * supaya bisa dibatasi role KHUSUS super_admin di index.js.
 */
async function permanentlyDeleteLegacyProjectAdmin(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Quotation tidak ditemukan: ' + data.project_id, 'not-found');
  if (!existing.legacy_project_data || !existing.legacy_project_data.isDeleted) {
    throwError('Quotation harus berada di Sampah dulu sebelum dihapus permanen', 'invalid-argument');
  }

  await deleteDoc(env, COL, data.project_id);
  return successResponse({ project_id: data.project_id }, 'Quotation dihapus permanen');
}

/**
 * Dipanggil saat status Project di app lama diubah jadi 'sent' DAN
 * project ini terhubung ke project Sales App (_salesProjectId ada) —
 * otomatis update balik Pipeline Stage jadi "Penawaran Siap".
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
    if (typeof data.estimated_value === 'number' && Number.isFinite(data.estimated_value)) {
      projectUpdates.estimated_value = data.estimated_value;
    }
    await updateDoc(env, CONFIG.COLLECTIONS.PROJECTS, doc.project_id, projectUpdates);
  }

  return successResponse({ notified: true }, 'Sales App sudah diberi tahu quotation ini terkirim');
}

module.exports = {
  listLegacyProjects, saveLegacyProject, deleteLegacyProject, createQuotationRevision,
  restoreLegacyProjectAdmin, permanentlyDeleteLegacyProjectAdmin, notifySalesQuotationSent
};
