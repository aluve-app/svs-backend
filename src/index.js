/**
 * ============================================================
 * INDEX.JS — Entry Point Cloudflare Workers
 * ============================================================
 * Pengganti index.js versi Cloud Functions. Karena Cloudflare
 * Workers tidak punya konsep "onCall" seperti Firebase, setiap
 * function sekarang jadi 1 endpoint HTTP biasa, dipanggil lewat
 * path URL, contoh:
 *
 *   POST https://svs-api.<akun-anda>.workers.dev/createProject
 *   POST https://svs-api.<akun-anda>.workers.dev/createActivity
 *
 * Body request berupa JSON, dan token login dikirim di header:
 *   Authorization: Bearer <id_token>
 *
 * Pola tiap route SAMA seperti sebelumnya:
 *   1. requireAuth()  → pastikan user login & aktif
 *   2. safeExecute()  → jalankan logic, tangani & catat error otomatis
 * ============================================================
 */

const { requireAuth, requireRole } = require('./lib/auth');
const { safeExecute } = require('./lib/errorHandler');
const { jsonResponse, CORS_HEADERS, AppError } = require('./lib/responseHelper');

const projectService = require('./services/projectService');
const activityService = require('./services/activityService');
const contactService = require('./services/contactService');
const photoService = require('./services/photoService');
const lookupService = require('./services/lookupService');
const dashboardService = require('./services/dashboardService');

// Daftar route: nama endpoint -> handler
// (requiresRole opsional, dicek SETELAH requireAuth)
const ROUTES = {
  createProject: { fn: (env, user, data) => projectService.createProject(env, user, data) },
  updateProject: { fn: (env, user, data) => projectService.updateProject(env, user, data) },
  readProject: { fn: (env, user, data) => projectService.readProject(env, user, data) },
  searchProject: { fn: (env, user, data) => projectService.searchProject(env, user, data) },
  filterProject: { fn: (env, user, data) => projectService.filterProject(env, user, data) },

  createActivity: { fn: (env, user, data) => activityService.createActivity(env, user, data) },
  readActivityTimeline: { fn: (env, user, data) => activityService.readActivityTimeline(env, user, data) },

  uploadPhoto: { fn: (env, user, data) => photoService.uploadPhoto(env, user, data) },

  createContact: { fn: (env, user, data) => contactService.createContact(env, user, data) },
  readContactsSummary: { fn: (env, user) => contactService.readContactsSummary(env, user) },
  readProjectContacts: { fn: (env, user, data) => contactService.readProjectContacts(env, user, data) },

  readLookupOptions: { fn: (env, user, data) => lookupService.readLookupOptions(env, user, data) },
  updateLookupOptions: { fn: (env, user, data) => lookupService.updateLookupOptions(env, user, data), roles: ['manager', 'super_admin'] },

  // Mengembalikan profil user yang sedang login (role, business_id, sales_code, dst).
  // requireAuth() di atas SUDAH mengambil dokumen ini dari Firestore untuk verifikasi,
  // jadi di sini tinggal dikembalikan langsung — tidak perlu query tambahan.
  readMyProfile: { fn: (env, user) => Promise.resolve(require('./lib/responseHelper').successResponse(user, 'Profil ditemukan')) },

  readNeedsFollowup: { fn: (env, user) => dashboardService.readNeedsFollowup(env, user) },
  readDashboard: { fn: (env, user) => dashboardService.readDashboard(env, user) },
  readSummaryDetail: { fn: (env, user, data) => dashboardService.readSummaryDetail(env, user, data) }
};

export default {
  async fetch(request, env) {
    // Preflight CORS (dibutuhkan browser sebelum kirim request POST sungguhan)
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const routeName = url.pathname.replace(/^\//, '');
    const route = ROUTES[routeName];

    if (!route) {
      return jsonResponse({ success: false, message: 'Endpoint tidak ditemukan: ' + routeName }, 404);
    }
    if (request.method !== 'POST') {
      return jsonResponse({ success: false, message: 'Method harus POST' }, 405);
    }

    let user;
    try {
      user = await requireAuth(request, env);
      if (route.roles) requireRole(user, route.roles);
    } catch (err) {
      if (err instanceof AppError) {
        return jsonResponse({ success: false, message: err.message }, err.status);
      }
      return jsonResponse({ success: false, message: 'Autentikasi gagal' }, 401);
    }

    let data = {};
    try {
      data = await request.json();
    } catch (e) {
      data = {};
    }

    return safeExecute(() => route.fn(env, user, data), env, routeName, user.uid);
  }
};
