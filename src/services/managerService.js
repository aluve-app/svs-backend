/**
 * ============================================================
 * MANAGER_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Port dari ManagerService.gs (Apps Script lama) — logic angka &
 * perhitungan SAMA PERSIS, hanya sumber data yang berubah:
 *   - Sheets "Projects"/"Activities"/"Sales_Master" (kunci Sales_Code)
 *     -> Firestore koleksi projects/activities/users (kunci sales_uid,
 *        nama diambil dari koleksi `users` dengan role "sales")
 *
 * SEMUA fungsi di sini scoped per business_id:
 *   - role sales/manager -> dipaksa pakai business_id akun sendiri
 *   - role super_admin   -> boleh pilih business_id lain lewat
 *     data.business_id (kalau tidak diisi, default ke business_id sendiri)
 *   Ini yang memungkinkan switcher bisnis Aluve/GBP di Dashboard.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');

const PROJ_COL = CONFIG.COLLECTIONS.PROJECTS;
const ACT_COL = CONFIG.COLLECTIONS.ACTIVITIES;
const USERS_COL = CONFIG.COLLECTIONS.USERS;

/** Tentukan business_id efektif sesuai role/akses — inti dari switcher bisnis */
function resolveBusinessId(user, data) {
  if (!data.business_id) return user.business_id;
  if (user.role === 'super_admin') return data.business_id;
  // Akun non-super_admin dengan akses multi-bisnis (business_ids berisi >1
  // bisnis) boleh pilih business_id manapun yang ada di daftar aksesnya.
  const allowed = Array.isArray(user.business_ids) ? user.business_ids : [user.business_id];
  if (allowed.includes(data.business_id)) return data.business_id;
  return user.business_id;
}

/** Ambil semua project, activity, dan daftar sales (dari users) untuk 1 business_id */
async function fetchManagerScopedData(env, businessId) {
  const [projectsRaw, activities, salesUsers] = await Promise.all([
    queryDocs(env, PROJ_COL, { where: [{ field: 'business_id', value: businessId }] }),
    queryDocs(env, ACT_COL, { where: [{ field: 'business_id', value: businessId }] }),
    queryDocs(env, USERS_COL, {
      where: [
        { field: 'business_id', value: businessId },
        { field: 'role', value: 'sales' }
      ]
    })
  ]);

  // Project yang sudah di-soft-delete (fitur "Hapus Project" di Admin
  // Console) TIDAK ikut dihitung di Overview/Explorer/Performa/Log —
  // sama seperti perilaku searchProject/filterProject di Sales App.
  const projects = projectsRaw.filter((p) => !p.is_deleted);

  const salesNameByUid = {};
  salesUsers.forEach((s) => { salesNameByUid[s.id] = s.name; });

  return { projects, activities, salesNameByUid };
}

/**
 * Helper internal: performa tiap sales dari kumpulan activities & projects
 * yang SUDAH difilter (dipakai bersama readManagerOverview & readSalesPerformance,
 * supaya logikanya konsisten di 2 tempat — sama seperti versi Apps Script).
 */
function computeSalesPerformance(activities, projects, salesNameByUid) {
  // Mulai dari SEMUA sales terdaftar (salesNameByUid), bukan cuma yang
  // kebetulan sudah punya project/aktivitas — supaya sales yang belum
  // pernah input apa pun tetap muncul dengan angka 0.
  const uids = new Set(Object.keys(salesNameByUid));
  activities.forEach((a) => { if (a.sales_uid) uids.add(a.sales_uid); });
  projects.forEach((p) => { if (p.sales_uid) uids.add(p.sales_uid); });

  const result = [];
  uids.forEach((uid) => {
    if (!uid) return;
    const salesActivities = activities.filter((a) => a.sales_uid === uid);
    const salesProjects = projects.filter((p) => p.sales_uid === uid);
    const wonProjects = salesProjects.filter((p) => p.pipeline_stage === CONFIG.PIPELINE_STAGE.WON);
    const lostProjects = salesProjects.filter((p) => p.pipeline_stage === CONFIG.PIPELINE_STAGE.LOST);
    const wonValue = wonProjects.reduce((sum, p) => sum + (Number(p.estimated_value) || 0), 0);

    result.push({
      sales_uid: uid,
      sales_name: salesNameByUid[uid] || uid,
      total_activities: salesActivities.length,
      // Di versi baru, tiap Activity = 1 kunjungan (sama seperti dashboardService
      // Sales App), jadi visit_count = total_activities.
      visit_count: salesActivities.length,
      won_count: wonProjects.length,
      lost_count: lostProjects.length,
      won_value: wonValue,
      active_projects_count: salesProjects.filter(
        (p) => p.pipeline_stage !== CONFIG.PIPELINE_STAGE.WON && p.pipeline_stage !== CONFIG.PIPELINE_STAGE.LOST
      ).length
    });
  });

  result.sort((a, b) => b.total_activities - a.total_activities);
  return result;
}

/**
 * Data lengkap Halaman Overview: KPI, funnel, breakdown, ranking sales,
 * project stale, follow up hari ini, aktivitas terbaru — 1 request.
 * @param {Object} data - { business_id?, date_from?, date_to?, sales_uid?,
 *   pipeline_stage?, product_type?, lead_source? } — semua opsional.
 *   date_from/date_to memfilter AKTIVITAS, bukan status project (status
 *   project selalu mencerminkan kondisi terkini).
 */
async function readManagerOverview(env, user, data) {
  const businessId = resolveBusinessId(user, data);
  const { projects: allProjects, activities: allActivities, salesNameByUid } =
    await fetchManagerScopedData(env, businessId);

  let projects = allProjects;
  if (data.sales_uid) projects = projects.filter((p) => p.sales_uid === data.sales_uid);
  if (data.pipeline_stage) projects = projects.filter((p) => p.pipeline_stage === data.pipeline_stage);
  if (data.product_type) projects = projects.filter((p) => String(p.product_type || '').indexOf(data.product_type) !== -1);
  if (data.lead_source) projects = projects.filter((p) => p.lead_source === data.lead_source);

  let activities = allActivities;
  if (data.sales_uid) activities = activities.filter((a) => a.sales_uid === data.sales_uid);
  if (data.date_from) activities = activities.filter((a) => new Date(a.timestamp) >= new Date(data.date_from));
  if (data.date_to) {
    const toDate = new Date(data.date_to);
    toDate.setHours(23, 59, 59, 999);
    activities = activities.filter((a) => new Date(a.timestamp) <= toDate);
  }

  const nonLostProjects = projects.filter((p) => p.pipeline_stage !== CONFIG.PIPELINE_STAGE.LOST);
  const totalPipelineValue = nonLostProjects.reduce((sum, p) => sum + (Number(p.estimated_value) || 0), 0);
  const wonProjects = projects.filter((p) => p.pipeline_stage === CONFIG.PIPELINE_STAGE.WON);
  const lostProjects = projects.filter((p) => p.pipeline_stage === CONFIG.PIPELINE_STAGE.LOST);
  const wonValue = wonProjects.reduce((sum, p) => sum + (Number(p.estimated_value) || 0), 0);
  const winRate = (wonProjects.length + lostProjects.length) > 0
    ? Math.round((wonProjects.length / (wonProjects.length + lostProjects.length)) * 100)
    : 0;

  const kpi = {
    total_projects: projects.length,
    total_pipeline_value: totalPipelineValue,
    won_value: wonValue,
    win_rate_percent: winRate,
    total_activities_period: activities.length
  };

  const funnel = {};
  projects.forEach((p) => { funnel[p.pipeline_stage] = (funnel[p.pipeline_stage] || 0) + 1; });

  const statusBreakdown = {
    won: wonProjects.length,
    lost: lostProjects.length,
    ongoing: projects.length - wonProjects.length - lostProjects.length
  };

  const lostReasons = {};
  lostProjects.forEach((p) => {
    const reason = p.lost_reason || 'Tidak diisi';
    lostReasons[reason] = (lostReasons[reason] || 0) + 1;
  });

  const productBreakdown = {};
  projects.forEach((p) => {
    String(p.product_type || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => {
      productBreakdown[t] = (productBreakdown[t] || 0) + 1;
    });
  });

  const leadSourceBreakdown = {};
  projects.forEach((p) => {
    const source = p.lead_source || 'Tidak Diisi';
    leadSourceBreakdown[source] = (leadSourceBreakdown[source] || 0) + 1;
  });

  const salesRanking = computeSalesPerformance(activities, projects, salesNameByUid);

  const staleProjects = projects
    .filter((p) => p.health_status === 'Stale')
    .map((p) => {
      const daysSince = Math.floor((new Date() - new Date(p.date_last_activity)) / 86400000);
      return {
        project_id: p.id,
        project_name: p.project_name,
        sales_uid: p.sales_uid,
        sales_name: salesNameByUid[p.sales_uid] || p.sales_uid,
        days_since_activity: daysSince
      };
    })
    .sort((a, b) => b.days_since_activity - a.days_since_activity);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const followupsToday = projects
    .filter((p) => p.pipeline_stage !== CONFIG.PIPELINE_STAGE.WON && p.pipeline_stage !== CONFIG.PIPELINE_STAGE.LOST)
    .map((p) => {
      const projectActivities = allActivities.filter((a) => a.project_id === p.id);
      if (projectActivities.length === 0) return null;
      projectActivities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const lastActivity = projectActivities[0];
      const followupDate = lastActivity.next_followup_date ? new Date(lastActivity.next_followup_date) : null;
      if (followupDate && followupDate <= today) {
        return {
          project_id: p.id,
          project_name: p.project_name,
          sales_uid: p.sales_uid,
          sales_name: salesNameByUid[p.sales_uid] || p.sales_uid,
          followup_date: followupDate
        };
      }
      return null;
    })
    .filter(Boolean);

  const projectNameById = {};
  allProjects.forEach((p) => { projectNameById[p.id] = p.project_name; });

  const recentActivities = activities.slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 15)
    .map((a) => ({
      activity_id: a.id,
      project_id: a.project_id,
      project_name: projectNameById[a.project_id] || a.project_id,
      sales_uid: a.sales_uid,
      sales_name: salesNameByUid[a.sales_uid] || a.sales_uid,
      activity_type: a.activity_type,
      note: a.activity_note,
      timestamp: a.timestamp
    }));

  return successResponse({
    business_id: businessId,
    kpi,
    funnel,
    status_breakdown: statusBreakdown,
    lost_reasons: lostReasons,
    product_breakdown: productBreakdown,
    lead_source_breakdown: leadSourceBreakdown,
    sales_ranking: salesRanking,
    stale_projects: staleProjects,
    followups_today: followupsToday,
    recent_activities: recentActivities
  }, 'Data overview Manager Dashboard berhasil dimuat');
}

/** Halaman Performa Sales — versi lengkap (tanpa batas jumlah) dari ranking di Overview */
async function readSalesPerformance(env, user, data) {
  const businessId = resolveBusinessId(user, data);
  const { projects, activities: allActivities, salesNameByUid } = await fetchManagerScopedData(env, businessId);

  let activities = allActivities;
  if (data.date_from) activities = activities.filter((a) => new Date(a.timestamp) >= new Date(data.date_from));
  if (data.date_to) {
    const toDate = new Date(data.date_to);
    toDate.setHours(23, 59, 59, 999);
    activities = activities.filter((a) => new Date(a.timestamp) <= toDate);
  }

  const performance = computeSalesPerformance(activities, projects, salesNameByUid);
  return successResponse(performance, 'Data performa sales berhasil dimuat');
}

/**
 * Tren aktivitas per hari/minggu/bulan — grafik garis di Overview.
 * Dibatasi: harian 30 hari terakhir, mingguan/bulanan 6 bulan terakhir.
 * @param {Object} data - { granularity: 'daily'|'weekly'|'monthly', business_id?, sales_uid? }
 */
async function readTrendData(env, user, data) {
  if (!data.granularity) throwError('granularity wajib diisi', 'invalid-argument');
  const businessId = resolveBusinessId(user, data);

  const where = [{ field: 'business_id', value: businessId }];
  if (data.sales_uid) where.push({ field: 'sales_uid', value: data.sales_uid });
  let activities = await queryDocs(env, ACT_COL, { where });

  const now = new Date();
  const startDate = new Date(now);
  if (data.granularity === 'daily') startDate.setDate(now.getDate() - 29);
  else startDate.setMonth(now.getMonth() - 6);
  startDate.setHours(0, 0, 0, 0);

  activities = activities.filter((a) => new Date(a.timestamp) >= startDate);

  function getLabel(date) {
    if (data.granularity === 'daily') {
      return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' });
    }
    if (data.granularity === 'weekly') {
      const d = new Date(date);
      const dayIndex = d.getDay();
      const diffToMonday = dayIndex === 0 ? 6 : dayIndex - 1;
      d.setDate(d.getDate() - diffToMonday);
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta' });
    }
    return date.toLocaleDateString('id-ID', { month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' });
  }

  const buckets = {};
  activities.forEach((a) => {
    const label = getLabel(new Date(a.timestamp));
    if (!buckets[label]) buckets[label] = { label, visit_count: 0, won_count: 0, lost_count: 0 };
    buckets[label].visit_count++;
    if (a.pipeline_stage_at_this_point === CONFIG.PIPELINE_STAGE.WON) buckets[label].won_count++;
    if (a.pipeline_stage_at_this_point === CONFIG.PIPELINE_STAGE.LOST) buckets[label].lost_count++;
  });

  // Urutkan berdasarkan tanggal asli (bukan alfabetis label)
  const sortedActivities = activities.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const orderedLabels = [];
  sortedActivities.forEach((a) => {
    const label = getLabel(new Date(a.timestamp));
    if (orderedLabels.indexOf(label) === -1) orderedLabels.push(label);
  });

  const series = orderedLabels.map((label) => buckets[label]);
  return successResponse(series, 'Data tren berhasil dimuat');
}

/**
 * Log aktivitas lintas semua project/sales, dengan filter & pagination.
 * @param {Object} data - { business_id?, date_from?, date_to?, sales_uid?, activity_type?, limit?, offset? }
 */
async function readActivityLog(env, user, data) {
  const businessId = resolveBusinessId(user, data);
  const { projects: allProjects, activities: allActivities, salesNameByUid } =
    await fetchManagerScopedData(env, businessId);

  const projectNameById = {};
  allProjects.forEach((p) => { projectNameById[p.id] = p.project_name; });

  let activities = allActivities;
  if (data.sales_uid) activities = activities.filter((a) => a.sales_uid === data.sales_uid);
  if (data.activity_type) activities = activities.filter((a) => a.activity_type === data.activity_type);
  if (data.date_from) activities = activities.filter((a) => new Date(a.timestamp) >= new Date(data.date_from));
  if (data.date_to) {
    const toDate = new Date(data.date_to);
    toDate.setHours(23, 59, 59, 999);
    activities = activities.filter((a) => new Date(a.timestamp) <= toDate);
  }

  activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const totalCount = activities.length;
  const limit = data.limit ? Number(data.limit) : 50;
  const offset = data.offset ? Number(data.offset) : 0;
  const page = activities.slice(offset, offset + limit).map((a) => ({
    activity_id: a.id,
    project_id: a.project_id,
    project_name: projectNameById[a.project_id] || a.project_id,
    sales_uid: a.sales_uid,
    sales_name: salesNameByUid[a.sales_uid] || a.sales_uid,
    activity_type: a.activity_type,
    note: a.activity_note,
    pipeline_stage: a.pipeline_stage_at_this_point,
    timestamp: a.timestamp
  }));

  return successResponse(
    { activities: page, total_count: totalCount },
    page.length + ' dari ' + totalCount + ' aktivitas'
  );
}

/** Daftar sales untuk dropdown filter (role=sales, per business_id) */
async function readSalesList(env, user, data) {
  const businessId = resolveBusinessId(user, data);
  const salesUsers = await queryDocs(env, USERS_COL, {
    where: [
      { field: 'business_id', value: businessId },
      { field: 'role', value: 'sales' }
    ]
  });
  const result = salesUsers.map((s) => ({ sales_uid: s.id, sales_name: s.name, status: s.status }));
  return successResponse(result, 'Daftar sales berhasil dimuat');
}

/** Project Explorer: daftar project + filter pencarian, untuk tabel eksplorasi */
async function readProjectExplorer(env, user, data) {
  const businessId = resolveBusinessId(user, data);
  const { projects: allProjects, salesNameByUid } = await fetchManagerScopedData(env, businessId);

  let projects = allProjects;
  if (data.sales_uid) projects = projects.filter((p) => p.sales_uid === data.sales_uid);
  if (data.pipeline_stage) projects = projects.filter((p) => p.pipeline_stage === data.pipeline_stage);
  if (data.product_type) projects = projects.filter((p) => String(p.product_type || '').indexOf(data.product_type) !== -1);
  if (data.lead_source) projects = projects.filter((p) => p.lead_source === data.lead_source);
  if (data.keyword) {
    const kw = String(data.keyword).toLowerCase();
    projects = projects.filter((p) =>
      String(p.project_name).toLowerCase().includes(kw) ||
      String(p.location_address).toLowerCase().includes(kw)
    );
  }

  const result = projects.map((p) => {
    const createdDate = new Date(p.date_created);
    const leadAgeDays = isNaN(createdDate.getTime()) ? null : Math.floor((new Date() - createdDate) / 86400000);
    return {
      project_id: p.id,
      project_name: p.project_name,
      location_address: p.location_address,
      product_type: p.product_type,
      pipeline_stage: p.pipeline_stage,
      estimated_value: p.estimated_value,
      health_status: p.health_status,
      sales_uid: p.sales_uid,
      sales_name: salesNameByUid[p.sales_uid] || p.sales_uid,
      date_created: p.date_created,
      date_last_activity: p.date_last_activity,
      lead_age_days: leadAgeDays // usia leads — jumlah hari sejak project dibuat
    };
  }).sort((a, b) => new Date(b.date_last_activity) - new Date(a.date_last_activity));

  return successResponse(result, result.length + ' project ditemukan');
}

/**
 * Daftar project yang sudah di-soft-delete (is_deleted=true) untuk halaman
 * "Sampah" di Admin Console → Kelola Project. Khusus super_admin (dicek
 * di index.js) — beda dari readProjectExplorer yang cuma untuk project aktif.
 */
async function readDeletedProjects(env, user, data) {
  const businessId = resolveBusinessId(user, data);

  const [projectsRaw, allUsers] = await Promise.all([
    queryDocs(env, PROJ_COL, {
      where: [
        { field: 'business_id', value: businessId },
        { field: 'is_deleted', value: true }
      ]
    }),
    queryDocs(env, USERS_COL, { where: [{ field: 'business_id', value: businessId }] })
  ]);

  // Pakai SEMUA user (bukan cuma role sales) supaya nama "dihapus oleh"
  // tetap kebaca meski yang menghapus manager/super_admin, bukan sales.
  const nameByUid = {};
  allUsers.forEach((u) => { nameByUid[u.id] = u.name; });

  const result = projectsRaw.map((p) => ({
    project_id: p.id,
    project_name: p.project_name,
    sales_uid: p.sales_uid,
    sales_name: nameByUid[p.sales_uid] || p.sales_uid,
    pipeline_stage: p.pipeline_stage,
    estimated_value: p.estimated_value,
    location_address: p.location_address,
    lead_source: p.lead_source,
    deleted_at: p.deleted_at,
    deleted_by_name: nameByUid[p.deleted_by] || p.deleted_by || '-'
  })).sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));

  return successResponse(result, result.length + ' project di Sampah');
}

module.exports = {
  readManagerOverview,
  readSalesPerformance,
  readTrendData,
  readActivityLog,
  readSalesList,
  readProjectExplorer,
  readDeletedProjects
};
