/**
 * ============================================================
 * DASHBOARD_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Pengganti bagian relevan dari DashboardService.gs lama.
 * Menyediakan 2 endpoint untuk Home Sales App:
 *
 * - readDashboard: 1 panggilan gabungan berisi
 *     { needs_followup: [...], summary: { today, week, month } }
 *   Setiap Activity yang tercatat dihitung sebagai 1 "kunjungan"
 *   (visit_count), terlepas dari activity_type-nya -- karena setiap
 *   Activity memang representasi 1 interaksi/kunjungan di lapangan.
 *   won_count/lost_count dihitung dari Activity yang statusnya saat
 *   itu Won/Lost, dalam periode terkait.
 *
 * - readSummaryDetail: rincian nama project yang menyusun salah
 *   satu angka ringkasan di atas (dipanggil saat kartu angka di-tap)
 * ============================================================
 */

const { CONFIG } = require('../config');
const { queryDocs, getDoc } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');

const ACT_COL = CONFIG.COLLECTIONS.ACTIVITIES;
const PROJ_COL = CONFIG.COLLECTIONS.PROJECTS;

/** Ambil semua project & activity dalam scope user (business + kepemilikan kalau sales) */
async function fetchScopedData(env, user) {
  const projectWhere = [{ field: 'business_id', value: user.business_id }];
  const activityWhere = [{ field: 'business_id', value: user.business_id }];
  if (user.role === 'sales') {
    projectWhere.push({ field: 'sales_uid', value: user.uid });
    activityWhere.push({ field: 'sales_uid', value: user.uid });
  }

  const [projects, activities] = await Promise.all([
    queryDocs(env, PROJ_COL, { where: projectWhere }),
    queryDocs(env, ACT_COL, { where: activityWhere })
  ]);

  return { projects, activities };
}

function computeNeedsFollowup(projects, activities) {
  const latestActivityByProject = {};
  activities.forEach((a) => {
    const existing = latestActivityByProject[a.project_id];
    if (!existing || new Date(a.timestamp) > new Date(existing.timestamp)) {
      latestActivityByProject[a.project_id] = a;
    }
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const needsFollowup = [];
  projects.forEach((p) => {
    if (p.pipeline_stage === CONFIG.PIPELINE_STAGE.WON || p.pipeline_stage === CONFIG.PIPELINE_STAGE.LOST) return;

    const lastActivity = latestActivityByProject[p.id];
    if (!lastActivity || !lastActivity.next_followup_date) return;

    const followupDate = new Date(lastActivity.next_followup_date);
    followupDate.setHours(0, 0, 0, 0);

    if (followupDate <= today) {
      const overdueDays = Math.floor((today - followupDate) / 86400000);
      needsFollowup.push({
        project_id: p.id,
        project_name: p.project_name,
        followup_date: lastActivity.next_followup_date,
        overdue_days: overdueDays
      });
    }
  });

  needsFollowup.sort((a, b) => b.overdue_days - a.overdue_days);
  return needsFollowup;
}

function periodStartDate(period) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (period === 'week') {
    const day = start.getDay(); // 0 = Minggu
    const diffToMonday = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diffToMonday);
  } else if (period === 'month') {
    start.setDate(1);
  }
  return start;
}

function computeSummaryForPeriod(activities, period) {
  const start = periodStartDate(period);
  const inPeriod = activities.filter((a) => new Date(a.timestamp) >= start);

  return {
    visit_count: inPeriod.length,
    won_count: inPeriod.filter((a) => a.pipeline_stage_at_this_point === CONFIG.PIPELINE_STAGE.WON).length,
    lost_count: inPeriod.filter((a) => a.pipeline_stage_at_this_point === CONFIG.PIPELINE_STAGE.LOST).length
  };
}

async function readDashboard(env, user) {
  const { projects, activities } = await fetchScopedData(env, user);

  const summary = {
    today: computeSummaryForPeriod(activities, 'today'),
    week: computeSummaryForPeriod(activities, 'week'),
    month: computeSummaryForPeriod(activities, 'month')
  };

  const needsFollowup = computeNeedsFollowup(projects, activities);

  return successResponse({ needs_followup: needsFollowup, summary }, 'Dashboard dimuat');
}

async function readNeedsFollowup(env, user) {
  const { projects, activities } = await fetchScopedData(env, user);
  const needsFollowup = computeNeedsFollowup(projects, activities);
  return successResponse(needsFollowup, needsFollowup.length + ' project perlu follow-up');
}

/**
 * @param {Object} data - { period: 'today'|'week'|'month', type: 'visit'|'won'|'lost' }
 */
async function readSummaryDetail(env, user, data) {
  if (!data.period || !data.type) throwError('period dan type wajib diisi', 'invalid-argument');

  const { activities } = await fetchScopedData(env, user);
  const start = periodStartDate(data.period);
  let inPeriod = activities.filter((a) => new Date(a.timestamp) >= start);

  if (data.type === 'won') inPeriod = inPeriod.filter((a) => a.pipeline_stage_at_this_point === CONFIG.PIPELINE_STAGE.WON);
  else if (data.type === 'lost') inPeriod = inPeriod.filter((a) => a.pipeline_stage_at_this_point === CONFIG.PIPELINE_STAGE.LOST);
  // type === 'visit' -> semua activity dalam periode, tidak difilter lagi

  inPeriod.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const uniqueProjectIds = [...new Set(inPeriod.map((a) => a.project_id))];
  const projectNames = {};
  await Promise.all(uniqueProjectIds.map(async (pid) => {
    const proj = await getDoc(env, PROJ_COL, pid);
    if (proj) projectNames[pid] = proj.project_name;
  }));

  const result = inPeriod.map((a) => ({
    project_id: a.project_id,
    project_name: projectNames[a.project_id] || a.project_id,
    timestamp: a.timestamp
  }));

  return successResponse(result, result.length + ' aktivitas ditemukan');
}

module.exports = { readDashboard, readNeedsFollowup, readSummaryDetail };
