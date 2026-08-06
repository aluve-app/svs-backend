/**
 * ============================================================
 * PHOTO_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateUploadPhoto } = require('../lib/validator');
const { requireOwnership } = require('../lib/auth');
const { generatePhotoId, generateUniqueId } = require('../lib/idGenerator');
const { uploadToCloudinary } = require('../lib/cloudinaryUpload');

const PHOTO_COL = CONFIG.COLLECTIONS.PHOTOS;
const PROJ_COL = CONFIG.COLLECTIONS.PROJECTS;

async function uploadPhoto(env, user, data) {
  validateUploadPhoto(data);

  if (data.photo_id) {
    const existing = await getDoc(env, PHOTO_COL, data.photo_id);
    if (existing) {
      return successResponse({ photo_id: data.photo_id, url: existing.cloudinary_url }, 'Foto sudah tersimpan sebelumnya');
    }
  }

  const project = await getDoc(env, PROJ_COL, data.project_id);
  if (!project) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  requireOwnership(user, project.sales_uid);

  const photoId = data.photo_id || (await generateUniqueId(generatePhotoId, env, PHOTO_COL));
  const fileName = `${photoId}_${data.project_id}_${user.sales_code || user.uid}`;
  const folder = `svs_photos/${user.business_id}/${data.project_id}`;

  let uploadResult;
  try {
    uploadResult = await uploadToCloudinary(env, data.file_base64, data.mime_type, { publicId: fileName, folder });
  } catch (err) {
    throwError('Gagal upload foto ke Cloudinary: ' + err.message, 'internal');
  }

  const now = new Date();
  const newPhoto = {
    activity_id: data.activity_id || '',
    project_id: data.project_id,
    business_id: user.business_id,
    cloudinary_public_id: uploadResult.public_id,
    cloudinary_url: uploadResult.secure_url,
    file_name: fileName,
    upload_timestamp: now
  };

  await setDoc(env, PHOTO_COL, photoId, newPhoto);
  return successResponse({ photo_id: photoId, url: uploadResult.secure_url }, 'Foto berhasil diunggah');
}

module.exports = { uploadPhoto };
