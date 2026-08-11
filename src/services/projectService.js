/**
 * ============================================================
 * PROJECT_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Logic bisnis IDENTIK dengan versi Cloud Functions — hanya cara
 * bicara ke Firestore yang berubah (pakai getDoc/setDoc/updateDoc/
 * queryDocs dari firestoreRest.js, bukan firebase-admin).
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, updateDoc, deleteDoc, queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateCreateProject, validateUpdateProject, validateRequiredFields } = require('../lib/validator');
const { requireOwnership } = require('../lib/auth');
const { generateProjectId, generateUniqueId } = require('../lib/idGenerator');
const { deleteFromCloudinary } = require('../lib/cloudinaryUpload');

const COL = CONFIG.COLLECTIONS.PROJECTS;

async function createProject(env, user, data) {
  validateCreateProject(data);

  if (data.project_id) {
    const existing = await getDoc(env, COL, data.project_id);
    if (existing) {
      return successResponse({ project_id: data.project_id }, 'Project sudah tersimpan sebelumnya');
    }
  }

  const projectId = data.project_id || (await generateUniqueId(generateProjectId, env, COL));
  const now = new Date();

  const newProject = {
    project_name: data.project_name,
    location_address: data.location_address,
    location_lat: data.location_lat || '',
    location_lng: data.location_lng || '',
    product_type: data.product_type,
    project_category: data.project_category || '',
    construction_stage: data.construction_stage || '',
    estimated_scale: data.estimated_scale || '',
    lead_source: data.lead_source || 'Canvassing',
    pipeline_stage: CONFIG.PIPELINE_STAGE.NEW_VISIT,
    estimated_value: data.estimated_value || '',
    sales_uid: user.uid,
    sales_code: user.sales_code || '',
    business_id: user.business_id,
    lost_reason: '',
    competitor_name: '',
    date_created: now,
    date_last_activity: now,
    health_status: 'Aktif'
  };

  await setDoc(env, COL, projectId, newProject);
  return successResponse({ project_id: projectId }, 'Project berhasil dibuat');
}

async function updateProject(env, user, data) {
  validateUpdateProject(data);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');

  requireOwnership(user, existing.sales_uid);

  const updatableFields = [
    'project_name', 'location_address', 'location_lat', 'location_lng',
    'product_type', 'project_category', 'construction_stage',
    'estimated_scale', 'competitor_name'
    // 'estimated_value' SENGAJA tidak diikutkan (Ags 2026) — angka ini
    // cuma boleh diisi otomatis dari Project Estimator lewat
    // notifySalesQuotationSent (legacyProjectService.js), yang menulis
    // langsung ke Firestore, BUKAN lewat fungsi updateProject ini. Kalau
    // ada yang kirim field ini ke endpoint /updateProject, diam-diam
    // diabaikan di sini (bukan error) supaya request lain di dalamnya
    // tetap jalan normal.
  ];

  const updates = {};
  updatableFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) updates[field] = data[field];
  });

  if (Object.keys(updates).length === 0) throwError('Tidak ada field yang diperbarui', 'invalid-argument');

  await updateDoc(env, COL, data.project_id, updates);
  return successResponse({ project_id: data.project_id }, 'Project berhasil diperbarui');
}

/**
 * Hapus project (SOFT DELETE) — ditandai is_deleted, BUKAN dihapus
 * sungguhan dari Firestore. Muncul di halaman "Sampah" (Manager
 * Dashboard → Admin Console → Kelola Project), tempat super_admin bisa
 * PULIHKAN (restoreProject) atau HAPUS PERMANEN (permanentlyDeleteProject).
 *
 * Aturan akses SAMA seperti updateProject: sales cuma boleh hapus
 * project miliknya sendiri (requireOwnership), manager/super_admin bebas.
 */
async function deleteProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');

  requireOwnership(user, existing.sales_uid);

  await updateDoc(env, COL, data.project_id, {
    is_deleted: true,
    deleted_at: new Date(),
    deleted_by: user.uid
  });

  return successResponse({ project_id: data.project_id }, 'Project dipindahkan ke Sampah');
}

/**
 * Pulihkan project dari Sampah — kebalikan dari deleteProject.
 * Khusus super_admin (dicek di index.js).
 */
async function restoreProject(env, user, data) {
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
 * Hapus project PERMANEN dari Firestore — TIDAK BISA DIBATALKAN. Hanya
 * bisa dilakukan pada project yang SUDAH ada di Sampah (is_deleted=true),
 * supaya tidak ada yang tidak sengaja lompat dari "aktif" langsung ke
 * "hilang selamanya". Khusus super_admin.
 *
 * Ikut dihapus (cascading), supaya tidak ada data "sampah" yang menumpuk
 * diam-diam di Firestore/Cloudinary:
 * - Semua activities milik project ini
 * - Semua photos milik project ini (dokumen Firestore-nya DAN file asli
 *   di Cloudinary — supaya kuota 25 credit/bulan tidak habis oleh foto
 *   project yang sudah tidak dipakai)
 * - Semua link project_contacts (relasi ke kontak) milik project ini
 *
 * TIDAK ikut dihapus: dokumen contact itu sendiri — karena 1 kontak
 * (mis. arsitek yang sama) bisa terhubung ke BEBERAPA project sekaligus,
 * jadi menghapusnya di sini bisa merusak data project lain yang masih aktif.
 */
async function permanentlyDeleteProject(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const existing = await getDoc(env, COL, data.project_id);
  if (!existing) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  if (!existing.is_deleted) throwError('Project harus dipindahkan ke Sampah dulu sebelum dihapus permanen', 'invalid-argument');

  const ACT_COL = CONFIG.COLLECTIONS.ACTIVITIES;
  const PHOTO_COL = CONFIG.COLLECTIONS.PHOTOS;
  const LINK_COL = CONFIG.COLLECTIONS.PROJECT_CONTACTS;

  const [activities, photos, links] = await Promise.all([
    queryDocs(env, ACT_COL, { where: [{ field: 'project_id', value: data.project_id }] }),
    queryDocs(env, PHOTO_COL, { where: [{ field: 'project_id', value: data.project_id }] }),
    queryDocs(env, LINK_COL, { where: [{ field: 'project_id', value: data.project_id }] })
  ]);

  // Hapus file foto di Cloudinary dulu — best-effort, kalau 1 foto gagal
  // dihapus di Cloudinary (mis. sudah kehapus manual sebelumnya), proses
  // tetap lanjut supaya Firestore-nya tetap bersih pada akhirnya.
  await Promise.all(photos.map(async (p) => {
    if (p.cloudinary_public_id) {
      try { await deleteFromCloudinary(env, p.cloudinary_public_id); } catch (err) { /* lanjut meski gagal */ }
    }
  }));

  await Promise.all([
    ...activities.map((a) => deleteDoc(env, ACT_COL, a.id)),
    ...photos.map((p) => deleteDoc(env, PHOTO_COL, p.id)),
    ...links.map((l) => deleteDoc(env, LINK_COL, l.id)),
    deleteDoc(env, COL, data.project_id)
  ]);

  return successResponse(
    { project_id: data.project_id },
    'Project dihapus permanen beserta ' + activities.length + ' aktivitas & ' + photos.length + ' foto'
  );
}

async function readProject(env, user, data) {
  if (!data.project_id) throwError('project_id wajib diisi', 'invalid-argument');
  const doc = await getDoc(env, COL, data.project_id);
  if (!doc) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  return successResponse(doc, 'Detail project ditemukan');
}

/**
 * CATATAN: sama seperti versi Firebase — Firestore tidak mendukung
 * pencarian substring native, jadi kita ambil semua project 1 bisnis
 * lalu filter di memori.
 */
async function searchProject(env, user, data) {
  if (!data.keyword) throwError('keyword wajib diisi', 'invalid-argument');

  const keyword = String(data.keyword).toLowerCase();
  const rows = await queryDocs(env, COL, { where: [{ field: 'business_id', value: user.business_id }] });

  // Sales App SELALU dibatasi ke project milik akun yang login sendiri —
  // berlaku untuk SEMUA role (sales/manager/super_admin), tidak ada
  // pengecualian. Melihat data lintas-anggota tim itu hak khusus Manager
  // Dashboard (lewat managerService.js yang endpoint-nya terpisah), bukan
  // Sales App. Sengaja TIDAK lagi mengandalkan data.sales_uid dari client
  // supaya tidak bisa dilewati (bypass) lewat panggilan API langsung.
  const results = rows.filter((row) => {
    if (row.is_deleted) return false; // project di Sampah tidak muncul di hasil pencarian normal
    if (row.sales_uid !== user.uid) return false;
    const matchKeyword =
      String(row.project_name).toLowerCase().includes(keyword) ||
      String(row.location_address).toLowerCase().includes(keyword);
    const matchLeadSource = data.lead_source ? row.lead_source === data.lead_source : true;
    return matchKeyword && matchLeadSource;
  }).map((row) => ({ project_id: row.id, ...row }));

  return successResponse(results, results.length + ' project ditemukan');
}

async function filterProject(env, user, data) {
  // Sama seperti searchProject di atas: SELALU dibatasi ke akun sendiri,
  // untuk semua role, tidak bisa dilewati dari client.
  const where = [
    { field: 'business_id', value: user.business_id },
    { field: 'sales_uid', value: user.uid }
  ];
  if (data.pipeline_stage) where.push({ field: 'pipeline_stage', value: data.pipeline_stage });

  const rows = await queryDocs(env, COL, { where });

  const results = rows.filter((row) => {
    if (row.is_deleted) return false; // project di Sampah tidak muncul di daftar normal
    let match = true;
    if (data.product_type) match = match && String(row.product_type).includes(data.product_type);
    if (data.lead_source) match = match && row.lead_source === data.lead_source;
    if (data.date_from) match = match && new Date(row.date_created) >= new Date(data.date_from);
    if (data.date_to) match = match && new Date(row.date_created) <= new Date(data.date_to);
    return match;
  }).map((row) => ({ project_id: row.id, ...row }));

  return successResponse(results, results.length + ' project sesuai filter');
}

async function recalculateProjectHealth(env, projectId) {
  const row = await getDoc(env, COL, projectId);
  if (!row) return;

  const lastActivityDate = new Date(row.date_last_activity);
  const now = new Date();
  const diffDays = Math.floor((now - lastActivityDate) / (1000 * 60 * 60 * 24));

  let healthStatus;
  const stage = row.pipeline_stage;

  if (stage === CONFIG.PIPELINE_STAGE.WON || stage === CONFIG.PIPELINE_STAGE.LOST) {
    healthStatus = stage;
  } else if (diffDays <= CONFIG.HEALTH_STATUS.ACTIVE_DAYS) {
    healthStatus = 'Aktif';
  } else if (diffDays <= CONFIG.HEALTH_STATUS.WARNING_DAYS) {
    healthStatus = 'Perlu Perhatian';
  } else {
    healthStatus = 'Stale';
  }

  await updateDoc(env, COL, projectId, { health_status: healthStatus });
}

module.exports = {
  createProject, updateProject, deleteProject, restoreProject, permanentlyDeleteProject,
  readProject, searchProject, filterProject, recalculateProjectHealth
};
