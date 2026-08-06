/**
 * ============================================================
 * CLOUDINARY_UPLOAD.JS
 * ============================================================
 * SDK resmi Cloudinary untuk Node.js tidak kompatibel dengan
 * Cloudflare Workers, jadi kita panggil langsung REST API-nya
 * pakai fetch(), dengan tanda tangan keamanan (signature) yang
 * kita hitung sendiri pakai Web Crypto — caranya identik dengan
 * yang dilakukan SDK resmi di belakang layar.
 * ============================================================
 */

async function sha1Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {Object} env - berisi CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 * @param {string} fileBase64 - isi file dalam base64 (tanpa prefix data:...)
 * @param {string} mimeType
 * @param {Object} options - { publicId, folder }
 * @return {Promise<{secure_url: string, public_id: string}>}
 */
async function uploadToCloudinary(env, fileBase64, mimeType, options) {
  const timestamp = Math.floor(Date.now() / 1000);

  // Parameter yang IKUT ditandatangani (urutan alfabetis, sesuai aturan Cloudinary)
  const paramsToSign = {
    folder: options.folder,
    public_id: options.publicId,
    timestamp
  };
  const sortedKeys = Object.keys(paramsToSign).sort();
  const stringToSign = sortedKeys.map((k) => `${k}=${paramsToSign[k]}`).join('&') + env.CLOUDINARY_API_SECRET;
  const signature = await sha1Hex(stringToSign);

  const form = new FormData();
  form.append('file', `data:${mimeType};base64,${fileBase64}`);
  form.append('api_key', env.CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', options.folder);
  form.append('public_id', options.publicId);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Gagal upload ke Cloudinary: ' + errText);
  }

  return res.json();
}

module.exports = { uploadToCloudinary };
