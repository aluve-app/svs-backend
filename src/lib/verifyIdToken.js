/**
 * ============================================================
 * VERIFY_ID_TOKEN.JS
 * ============================================================
 * Di Cloud Functions, Firebase otomatis mengecek keabsahan token
 * login user (lewat context.auth). Di Cloudflare Workers, kita
 * cek ini SENDIRI di setiap request:
 * 1. Ambil "kunci publik" resmi dari Google (dipakai untuk
 *    memastikan token tidak dipalsukan)
 * 2. Cocokkan tanda tangan digital token dengan kunci itu
 * 3. Cek token belum kadaluarsa & memang untuk project Firebase kita
 *
 * Hasilnya: kita dapat "uid" (identitas user) yang SUDAH TERBUKTI
 * asli — persis seperti context.auth.uid di versi Cloud Functions.
 * ============================================================
 */

let cachedKeys = null; // { keys, expiresAt }

function base64UrlToUint8Array(base64Url) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(base64Url) {
  const bytes = base64UrlToUint8Array(base64Url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function getGooglePublicKeys() {
  const now = Date.now();
  if (cachedKeys && cachedKeys.expiresAt > now) return cachedKeys.keys;

  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!res.ok) throw new Error('Gagal mengambil kunci publik Google');
  const jwks = await res.json();

  cachedKeys = { keys: jwks.keys, expiresAt: now + 3600 * 1000 }; // cache 1 jam
  return cachedKeys.keys;
}

/**
 * @param {string} idToken - token login yang dikirim frontend (header Authorization: Bearer ...)
 * @param {string} projectId - Firebase Project ID (untuk cek klaim "aud")
 * @return {Promise<Object>} payload token kalau valid: { uid, email, ... }
 * @throws {Error} kalau token tidak valid/kadaluarsa
 */
async function verifyIdToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Format token tidak valid');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token sudah kadaluarsa, silakan login ulang');
  if (payload.aud !== projectId) throw new Error('Token bukan untuk project ini');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Token tidak valid (issuer salah)');
  if (!payload.sub) throw new Error('Token tidak berisi identitas user');

  const keys = await getGooglePublicKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Kunci verifikasi token tidak ditemukan');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlToUint8Array(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );

  if (!isValid) throw new Error('Tanda tangan token tidak valid');

  return { uid: payload.sub, email: payload.email || null };
}

module.exports = { verifyIdToken };
