/**
 * ============================================================
 * FIRESTORE_TYPES.JS
 * ============================================================
 * Firestore REST API tidak menerima JSON biasa — setiap nilai
 * harus "dibungkus" dengan penanda tipe datanya, contoh:
 *   "Budi"     →  { stringValue: "Budi" }
 *   123        →  { integerValue: "123" }
 *   true       →  { booleanValue: true }
 *
 * File ini mengurus "bungkus" (JS → Firestore) dan "buka bungkus"
 * (Firestore → JS) itu secara otomatis, supaya kode Service lain
 * tetap bisa bekerja dengan object JavaScript biasa seperti sebelumnya.
 * ============================================================
 */

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: toFirestoreFields(value) } };
  }
  return { stringValue: String(value) };
}

function toFirestoreFields(obj) {
  const fields = {};
  Object.keys(obj).forEach((key) => {
    if (obj[key] !== undefined) fields[key] = toFirestoreValue(obj[key]);
  });
  return fields;
}

function fromFirestoreValue(value) {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in value) {
    return fromFirestoreFields(value.mapValue.fields || {});
  }
  return null;
}

function fromFirestoreFields(fields) {
  const obj = {};
  Object.keys(fields || {}).forEach((key) => {
    obj[key] = fromFirestoreValue(fields[key]);
  });
  return obj;
}

/**
 * Mengubah 1 dokumen hasil Firestore REST API (punya field "name" berisi
 * path lengkap) jadi object JS biasa + tambahan field id (diambil dari
 * bagian akhir path).
 */
function fromFirestoreDocument(doc) {
  if (!doc || !doc.fields) return null;
  const parts = doc.name.split('/');
  const id = parts[parts.length - 1];
  return { id, ...fromFirestoreFields(doc.fields) };
}

module.exports = { toFirestoreValue, toFirestoreFields, fromFirestoreValue, fromFirestoreFields, fromFirestoreDocument };
