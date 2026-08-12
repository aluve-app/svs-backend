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

/**
 * PATCH BUSINESS SWITCHER: sebelumnya semua fungsi di file ini SELALU
 * pakai user.business_id (bisnis utama akun) — akun yang punya akses ke
 * lebih dari 1 bisnis (business_ids: ["gbp","aluve"], misalnya manager
 * seperti Herman) jadi tidak bisa pindah lihat data bisnis lain di
 * Project Estimator, padahal Manager Dashboard sudah bisa.
 *
 * Fungsi ini yang memutuskan business_id mana yang BOLEH dipakai untuk 1
 * request: kalau frontend kirim business_id tertentu (lewat switcher),
 * itu dipakai — TAPI hanya kalau user memang berhak (business_id itu ada
 * di user.business_ids, atau dia super_admin). Kalau tidak dikirim atau
 * tidak berhak, fallback ke business_id utama akun (aman by default).
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
  // Field revisi/kunci SELALU diambil dari envelope (bukan dari
  // legacy_project_data) — envelope-lah sumber kebenaran untuk ini,
  // supaya tidak bisa "ketimpa" tidak sengaja waktu Estimator save.
  const revisionOverlay = {
    revisionNumber: doc.revision_number || 1,
    isLocked: !!doc.is_locked,
    rootProjectId: doc.root_project_id || doc.id
  };

  if (doc.legacy_project_data) {
    // Sudah pernah disimpan lewat app ini — kembalikan apa adanya,
    // hanya pastikan projectId selalu sinkron dengan Firestore doc id.
    return Object.assign({}, doc.legacy_project_data, { projectId: doc.id }, revisionOverlay);
  }
  // Belum pernah dibuka di app ini (misal quotation auto-dibuat oleh
  // Sales App saat Pipeline Stage jadi "Perlu Estimasi Harga") — susun
  // objek Project kosong dari field ringkasan yang sudah ada.
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
    _salesProjectId: doc.project_id || '' // dipakai frontend untuk tahu ini terhubung ke Sales App atau tidak
  }, revisionOverlay);
}

/** Daftar seluruh "Project" (quotation) milik business_id user — dipetakan ke bentuk app lama. */
async function listLegacyProjects(env, user, data) {
  const businessId = resolveBusinessId(user, data && data.business_id);
  const rows = await queryDocs(env, COL, {
    where: [{ field: 'business_id', value: businessId }],
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
  if (existing && existing.is_locked) {
    throwError('Quotation ini sudah dikunci (revisi lama) — tidak bisa diedit lagi. Buka revisi terbaru untuk melanjutkan.', 'failed-precondition');
  }

  const now = new Date();
  const businessId = existing ? existing.business_id : resolveBusinessId(user, data.business_id);

  const doc = {
    business_id: businessId,
    project_id: (existing && existing.project_id) || '', // link ke project Sales App, kalau ada — tidak pernah diubah dari sini
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
 * Dipanggil manual lewat tombol "Buat Revisi Baru" di halaman Detail
 * Project (bukan otomatis).
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
    status: 'draft' // revisi baru selalu mulai dari draft, meski induknya sudah 'sent'
  });

  const newDoc = {
    business_id: source.business_id,
    project_id: source.project_id || '', // tetap terhubung ke project Sales App yang sama, kalau ada
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

  // Kunci dokumen sumber — jadi arsip/history, tidak bisa diedit lagi.
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

module.exports = { listLegacyProjects, saveLegacyProject, deleteLegacyProject, notifySalesQuotationSent, createQuotationRevision };
