/**
 * ============================================================
 * ID_GENERATOR.JS
 * ============================================================
 * Pengganti IdGenerator.gs. Format ID SAMA PERSIS dengan versi
 * lama supaya konsisten kalau nanti data lama & baru pernah
 * perlu dibandingkan/ditelusuri manual:
 *
 *   Project_ID  : PRJ-YYYYMMDD-XXXX
 *   Activity_ID : ACT-YYYYMMDDHHMMSS-XXXX
 *   Photo_ID    : PHT-YYYYMMDDHHMMSS-XXXX
 *   Contact_ID  : CNT-YYYYMMDD-XXXX
 *
 * Di Firestore, ID ini dipakai LANGSUNG sebagai document ID
 * (bukan auto-id Firestore), supaya tetap human-readable dan
 * konsisten dengan struktur lama.
 * ============================================================
 */

const TIMEZONE = 'Asia/Jakarta';

function generateRandomSuffix() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function getPartsInTimezone(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = {};
  formatter.formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return parts;
}

function formatDateYYYYMMDD(date) {
  const p = getPartsInTimezone(date);
  return `${p.year}${p.month}${p.day}`;
}

function formatDateTimeFull(date) {
  const p = getPartsInTimezone(date);
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

function generateProjectId() {
  return 'PRJ-' + formatDateYYYYMMDD(new Date()) + '-' + generateRandomSuffix();
}

function generateActivityId() {
  return 'ACT-' + formatDateTimeFull(new Date()) + '-' + generateRandomSuffix();
}

function generatePhotoId() {
  return 'PHT-' + formatDateTimeFull(new Date()) + '-' + generateRandomSuffix();
}

function generateContactId() {
  return 'CNT-' + formatDateYYYYMMDD(new Date()) + '-' + generateRandomSuffix();
}

/**
 * Membuat ID unik dengan mengecek langsung ke Firestore (retry kalau
 * kebetulan tabrakan — meski secara statistik nyaris mustahil).
 *
 * @param {Function} generatorFn - salah satu generate*Id di atas
 * @param {Object} env - environment Workers (berisi kredensial Firebase)
 * @param {string} collection - nama koleksi Firestore
 * @return {Promise<string>}
 */
async function generateUniqueId(generatorFn, env, collection) {
  const { getDoc } = require('./firestoreRest');
  let id = generatorFn();
  let attempts = 0;
  while (attempts < 5) {
    const doc = await getDoc(env, collection, id);
    if (!doc) return id;
    id = generatorFn();
    attempts++;
  }
  return id; // setelah 5x percobaan, tetap pakai yang terakhir (praktis tak mungkin tabrakan)
}

module.exports = {
  generateProjectId,
  generateActivityId,
  generatePhotoId,
  generateContactId,
  generateUniqueId
};
