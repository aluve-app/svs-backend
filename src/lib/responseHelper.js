/**
 * ============================================================
 * RESPONSE_HELPER.JS
 * ============================================================
 * Di Cloud Functions (onCall), Firebase otomatis membungkus hasil
 * jadi respons yang dimengerti frontend. Di Cloudflare Workers,
 * kita balas request HTTP secara manual — file ini yang mengurus
 * format responsnya supaya TETAP SAMA seperti sebelumnya:
 * { success, data, message }
 * ============================================================
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: CORS_HEADERS });
}

function successResponse(data, message) {
  return jsonResponse({ success: true, data: data !== undefined ? data : null, message: message || 'OK' }, 200);
}

/**
 * Kelas error khusus aplikasi kita — membawa juga kode status HTTP
 * yang sesuai (setara "code" pada HttpsError versi Firebase).
 */
class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 500;
  }
}

const ERROR_STATUS = {
  'invalid-argument': 400,
  'unauthenticated': 401,
  'permission-denied': 403,
  'not-found': 404,
  'internal': 500
};

function throwError(message, code) {
  throw new AppError(message, ERROR_STATUS[code] || 500);
}

module.exports = { successResponse, throwError, jsonResponse, AppError, CORS_HEADERS };
