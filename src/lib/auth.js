/**
 * ============================================================
 * AUTH.JS
 * ============================================================
 * Versi Cloudflare Workers. Bedanya dari versi Cloud Functions:
 * di sana Firebase otomatis mengisi "request.auth". Di sini, token
 * login dikirim frontend lewat header HTTP:
 *     Authorization: Bearer <id_token>
 * dan kita verifikasi sendiri pakai verifyIdToken.js.
 *
 * Setelah token terbukti asli, langkah berikutnya SAMA seperti
 * sebelumnya: cek dokumen user di koleksi "users" Firestore untuk
 * pastikan statusnya aktif.
 * ============================================================
 */

const { verifyIdToken } = require('./verifyIdToken');
const { getDoc } = require('./firestoreRest');
const { AppError } = require('./responseHelper');
const { CONFIG } = require('../config');

/**
 * @param {Request} request - request HTTP masuk ke Worker
 * @param {Object} env
 * @return {Promise<Object>} data user: { uid, name, role, business_id, sales_code, status, ... }
 */
async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!idToken) {
    throw new AppError('Anda harus login terlebih dahulu.', 401);
  }

  let decoded;
  try {
    decoded = await verifyIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (err) {
    throw new AppError('Token login tidak valid: ' + err.message, 401);
  }

  const userData = await getDoc(env, CONFIG.COLLECTIONS.USERS, decoded.uid);

  if (!userData) {
    throw new AppError('Akun ini belum terdaftar di sistem SVS.', 403);
  }
  if (String(userData.status).toLowerCase() !== 'aktif') {
    throw new AppError('Akun Anda tidak aktif. Hubungi admin.', 403);
  }

  return { uid: decoded.uid, ...userData };
}

function requireRole(user, allowedRoles) {
  if (!allowedRoles.includes(user.role)) {
    throw new AppError('Anda tidak punya akses untuk aksi ini.', 403);
  }
}

function requireOwnership(user, ownerUid) {
  if (user.role === 'sales' && user.uid !== ownerUid) {
    throw new AppError('Data ini bukan milik Anda.', 403);
  }
}

module.exports = { requireAuth, requireRole, requireOwnership };
