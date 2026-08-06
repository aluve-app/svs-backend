/**
 * ============================================================
 * FIRESTORE_REST.JS
 * ============================================================
 * Pengganti "getFirestore()" dari firebase-admin. Semua fungsi di
 * sini melakukan hal yang SAMA seperti sebelumnya (get, set, update,
 * delete, query dokumen), hanya saja lewat panggilan HTTP biasa ke
 * Firestore REST API, karena firebase-admin tidak bisa jalan di
 * Cloudflare Workers.
 *
 * Kode di file services/*.js TIDAK perlu tahu detail ini — mereka
 * cukup memanggil fungsi seperti getDoc(), setDoc(), dst, persis
 * seperti pola sebelumnya.
 * ============================================================
 */

const { getGoogleAccessToken } = require('./googleAuth');
const { toFirestoreFields, fromFirestoreDocument } = require('./firestoreTypes');

function baseUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

async function authHeader(env) {
  // env.FIREBASE_SERVICE_ACCOUNT disimpan sebagai TEKS JSON (lewat wrangler secret),
  // karena Cloudflare secret cuma bisa menyimpan string — bukan object.
  const serviceAccount = typeof env.FIREBASE_SERVICE_ACCOUNT === 'string'
    ? JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)
    : env.FIREBASE_SERVICE_ACCOUNT;
  const token = await getGoogleAccessToken(serviceAccount);
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Mengambil satu dokumen. Return null kalau tidak ada (mirip doc.exists === false).
 */
async function getDoc(env, collection, id) {
  const headers = await authHeader(env);
  const res = await fetch(`${baseUrl(env.FIREBASE_PROJECT_ID)}/${collection}/${id}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gagal membaca ${collection}/${id}: ` + (await res.text()));
  const doc = await res.json();
  return fromFirestoreDocument(doc);
}

/**
 * Membuat/menimpa dokumen dengan ID yang sudah ditentukan (setara .doc(id).set()).
 */
async function setDoc(env, collection, id, data) {
  const headers = await authHeader(env);
  const res = await fetch(`${baseUrl(env.FIREBASE_PROJECT_ID)}/${collection}/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`Gagal menyimpan ${collection}/${id}: ` + (await res.text()));
  return true;
}

/**
 * Update sebagian field saja (setara .doc(id).update()), field lain yang
 * sudah ada di dokumen TIDAK ikut terhapus — pakai updateMask.
 */
async function updateDoc(env, collection, id, data) {
  const headers = await authHeader(env);
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${baseUrl(env.FIREBASE_PROJECT_ID)}/${collection}/${id}?${mask}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`Gagal update ${collection}/${id}: ` + (await res.text()));
  return true;
}

/**
 * Menambah dokumen baru dengan ID otomatis dari Firestore (setara .add()).
 */
async function addDoc(env, collection, data) {
  const headers = await authHeader(env);
  const res = await fetch(`${baseUrl(env.FIREBASE_PROJECT_ID)}/${collection}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`Gagal menambah dokumen ke ${collection}: ` + (await res.text()));
  const doc = await res.json();
  return fromFirestoreDocument(doc);
}

/**
 * Query dokumen dengan filter kesetaraan (where "==") + opsional
 * orderBy/limit — setara .where().orderBy().limit().get().
 *
 * @param {Object} options - { where: [{field, op, value}], orderBy: {field, direction}, limit }
 */
async function queryDocs(env, collection, options = {}) {
  const headers = await authHeader(env);

  const structuredQuery = {
    from: [{ collectionId: collection }]
  };

  if (options.where && options.where.length > 0) {
    const filters = options.where.map((w) => ({
      fieldFilter: {
        field: { fieldPath: w.field },
        op: w.op || 'EQUAL',
        value: require('./firestoreTypes').toFirestoreValue(w.value)
      }
    }));
    structuredQuery.where = filters.length === 1
      ? filters[0]
      : { compositeFilter: { op: 'AND', filters } };
  }

  if (options.orderBy) {
    structuredQuery.orderBy = [{
      field: { fieldPath: options.orderBy.field },
      direction: options.orderBy.direction === 'desc' ? 'DESCENDING' : 'ASCENDING'
    }];
  }

  if (options.limit) structuredQuery.limit = options.limit;

  const res = await fetch(`${baseUrl(env.FIREBASE_PROJECT_ID)}:runQuery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ structuredQuery })
  });

  if (!res.ok) throw new Error(`Gagal query ${collection}: ` + (await res.text()));

  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => fromFirestoreDocument(r.document));
}

module.exports = { getDoc, setDoc, updateDoc, addDoc, queryDocs };
