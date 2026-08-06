/**
 * ============================================================
 * ERROR_HANDLER.JS
 * ============================================================
 * Sama seperti versi Firebase: mencatat setiap error ke koleksi
 * Firestore "error_log" (kini lewat REST API), lalu membalas
 * request dengan pesan error yang rapi.
 * ============================================================
 */

const { addDoc } = require('./firestoreRest');
const { CONFIG } = require('../config');
const { jsonResponse, AppError } = require('./responseHelper');

async function logError(env, source, userId, error) {
  try {
    const message = (error && error.message) ? error.message : String(error);
    await addDoc(env, CONFIG.COLLECTIONS.ERROR_LOG, {
      timestamp: new Date(),
      source,
      user_id: userId || '-',
      message
    });
  } catch (logErr) {
    // Sengaja tidak dilempar lagi — jangan sampai pencatatan log
    // menghentikan proses utama.
    console.error('Gagal mencatat error log:', logErr);
  }
}

/**
 * Wrapper eksekusi aman untuk setiap route. Menangkap semua error,
 * mencatatnya ke error_log, dan mengembalikan Response HTTP yang sesuai.
 *
 * @param {Function} fn - async function yang mengembalikan Response
 * @param {Object} env
 * @param {string} source - nama endpoint, untuk keperluan log
 * @param {string} userId
 */
async function safeExecute(fn, env, source, userId) {
  try {
    return await fn();
  } catch (err) {
    await logError(env, source, userId, err);
    if (err instanceof AppError) {
      return jsonResponse({ success: false, message: err.message }, err.status);
    }
    return jsonResponse({ success: false, message: 'Terjadi kesalahan pada proses: ' + source }, 500);
  }
}

module.exports = { logError, safeExecute };
