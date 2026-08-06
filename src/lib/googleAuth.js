/**
 * ============================================================
 * GOOGLE_AUTH.JS
 * ============================================================
 * Di Node.js biasa, library "firebase-admin" otomatis mengurus
 * autentikasi ke Google. Cloudflare Workers TIDAK bisa memakai
 * firebase-admin (beda mesin/runtime), jadi proses ini kita
 * tulis manual di sini, memakai Web Crypto API bawaan Workers.
 *
 * Alurnya (standar Google OAuth2 "Service Account"):
 * 1. Buat JWT (semacam "surat sakti" digital), ditandatangani pakai
 *    private key dari Service Account Key JSON
 * 2. Tukar JWT itu ke Google, dapat "access token" sementara (berlaku 1 jam)
 * 3. Access token itu dipakai untuk semua request ke Firestore REST API
 *
 * Token di-cache di memori (variabel module-level) supaya tidak
 * perlu minta token baru di SETIAP request — cukup kalau sudah
 * kadaluarsa atau isolate Workers baru "bangun".
 * ============================================================
 */

let cachedToken = null; // { accessToken, expiresAt }

function base64UrlEncode(bytes) {
  let str = typeof bytes === 'string'
    ? btoa(bytes)
    : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * @param {Object} serviceAccount - hasil JSON.parse() dari file Service Account Key
 * @param {Array<string>} scopes - scope Google API yang diminta
 */
async function createSignedJwt(serviceAccount, scopes) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedToken)
  );

  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

/**
 * Mengambil access token yang valid (dari cache kalau masih berlaku,
 * atau minta baru ke Google kalau sudah/hampir kadaluarsa).
 *
 * @param {Object} serviceAccount - dari environment variable FIREBASE_SERVICE_ACCOUNT
 */
async function getGoogleAccessToken(serviceAccount) {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.accessToken;
  }

  const scopes = [
    'https://www.googleapis.com/auth/datastore',
    'https://www.googleapis.com/auth/identitytoolkit'
  ];

  const jwt = await createSignedJwt(serviceAccount, scopes);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error('Gagal mendapatkan Google access token: ' + errText);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000
  };

  return cachedToken.accessToken;
}

module.exports = { getGoogleAccessToken };
