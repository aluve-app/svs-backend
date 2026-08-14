/**
 * ============================================================
 * ACTIVITY_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, updateDoc, queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateCreateActivity, validateRequiredFields } = require('../lib/validator');
const { requireOwnership } = require('../lib/auth');
const { generateActivityId, generateUniqueId } = require('../lib/idGenerator');
const { recalculateProjectHealth } = require('./projectService');
const { createQuotationFromProject } = require('./quotationService');

const ACT_COL = CONFIG.COLLECTIONS.ACTIVITIES;
const PROJ_COL = CONFIG.COLLECTIONS.PROJECTS;
const PHOTO_COL = CONFIG.COLLECTIONS.PHOTOS;

async function createActivity(env, user, data) {
  validateCreateActivity(data);

  if (data.activity_id) {
    const existing = await getDoc(env, ACT_COL, data.activity_id);
    if (existing) return successResponse({ activity_id: data.activity_id }, 'Aktivitas sudah tersimpan sebelumnya');
  }

  const project = await getDoc(env, PROJ_COL, data.project_id);
  if (!project) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  requireOwnership(user, project.sales_uid);

  const activityId = data.activity_id || (await generateUniqueId(generateActivityId, env, ACT_COL));
  const now = new Date();

  const photoIds = Array.isArray(data.photo_ids) ? data.photo_ids : (data.photo_id ? [data.photo_id] : []);

  const newActivity = {
    project_id: data.project_id,
    activity_type: data.activity_type,
    activity_note: data.activity_note,
    pipeline_stage_at_this_point: data.pipeline_stage,
    temperature: data.temperature || '', // sempat KETIMPA sesi lain, dikembalikan (Ags 2026)
    next_followup_date: data.next_followup_date || '',
    sales_uid: user.uid,
    business_id: user.business_id,
    timestamp: now,
    gps_lat: data.gps_lat || '',
    gps_lng: data.gps_lng || '',
    has_photo: photoIds.length > 0
  };

  await setDoc(env, ACT_COL, activityId, newActivity);

  await Promise.all(photoIds.map((photoId) =>
    updateDoc(env, PHOTO_COL, photoId, { activity_id: activityId }).catch(() => {
      // photoId tidak ditemukan — lewati, jangan gagalkan penyimpanan activity utama
    })
  ));

  const projectUpdates = { pipeline_stage: data.pipeline_stage, date_last_activity: now };
  if (data.pipeline_stage === CONFIG.PIPELINE_STAGE.LOST && data.lost_reason) {
    projectUpdates.lost_reason = data.lost_reason;
  }
  await updateDoc(env, PROJ_COL, data.project_id, projectUpdates);
  await recalculateProjectHealth(env, data.project_id);

  // --- Integrasi Sales <-> Estimator ---
  // Begitu Pipeline Stage project diubah jadi "Perlu Estimasi Harga",
  // otomatis bikin dokumen quotation baru terisi dari data project,
  // supaya langsung muncul di antrian Project Estimator. Sengaja
  // dibungkus try/catch terpisah: kalau ini gagal karena sebab apa
  // pun, penyimpanan activity utama (di atas) TETAP dianggap berhasil
  // — sales tidak boleh terhalang cuma karena hook ini bermasalah.
  if (data.pipeline_stage === CONFIG.PIPELINE_STAGE.NEEDS_ESTIMATION) {
    try {
      await createQuotationFromProject(env, { ...project, project_id: data.project_id }, data.project_id);
    } catch (err) {
      console.error('Gagal membuat quotation otomatis untuk project ' + data.project_id + ':', err);
    }
  }

  return successResponse({ activity_id: activityId }, 'Aktivitas berhasil disimpan');
}

async function readActivityTimeline(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const activities = await queryDocs(env, ACT_COL, {
    where: [{ field: 'project_id', value: data.project_id }],
    orderBy: { field: 'timestamp', direction: 'desc' }
  });

  const activitiesWithPhotos = await Promise.all(activities.map(async (activity) => {
    const photos = await queryDocs(env, PHOTO_COL, { where: [{ field: 'activity_id', value: activity.id }] });
    return {
      activity_id: activity.id,
      ...activity,
      photos: photos.map((p) => ({ photo_id: p.id, url: p.cloudinary_url }))
    };
  }));

  return successResponse(activitiesWithPhotos, activitiesWithPhotos.length + ' aktivitas ditemukan');
}

module.exports = { createActivity, readActivityTimeline };
