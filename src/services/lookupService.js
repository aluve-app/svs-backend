/**
 * ============================================================
 * LOOKUP_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');

const COL = CONFIG.COLLECTIONS.LOOKUPS;

async function readLookupOptions(env, user, data) {
  const businessId = data.business_id || user.business_id;
  if (!businessId) throwError('business_id tidak diketahui', 'invalid-argument');

  const doc = await getDoc(env, COL, businessId);
  if (!doc) {
    return successResponse(
      { activity_type: [], pipeline_stage: [], product_type: [], lost_reason: [], contact_role: [] },
      'Lookup untuk bisnis ini belum diatur'
    );
  }
  return successResponse(doc, 'Data lookup berhasil dimuat');
}

async function updateLookupOptions(env, user, data) {
  const businessId = data.business_id || user.business_id;
  const { lookup_type, values } = data;

  if (!businessId || !lookup_type || !Array.isArray(values)) {
    throwError('business_id, lookup_type, dan values (array) wajib diisi', 'invalid-argument');
  }

  const existing = (await getDoc(env, COL, businessId)) || {};
  delete existing.id;
  existing[lookup_type] = values;

  await setDoc(env, COL, businessId, existing);
  return successResponse({ business_id: businessId, lookup_type }, 'Lookup berhasil diperbarui');
}

module.exports = { readLookupOptions, updateLookupOptions };
