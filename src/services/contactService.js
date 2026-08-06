/**
 * ============================================================
 * CONTACT_SERVICE.JS (Cloudflare Workers)
 * ============================================================
 * Catatan: untuk mengambil banyak contact sekaligus berdasarkan
 * daftar ID, versi Firebase memakai query "in" (batch 30). Di sini
 * kita ambil satu-satu secara paralel (Promise.all) — lebih
 * sederhana dan cukup cepat untuk skala data kita saat ini.
 * ============================================================
 */

const { CONFIG } = require('../config');
const { getDoc, setDoc, addDoc, queryDocs } = require('../lib/firestoreRest');
const { successResponse, throwError } = require('../lib/responseHelper');
const { validateCreateContact, validateRequiredFields } = require('../lib/validator');
const { requireOwnership } = require('../lib/auth');
const { generateContactId, generateUniqueId } = require('../lib/idGenerator');

const CONTACT_COL = CONFIG.COLLECTIONS.CONTACTS;
const LINK_COL = CONFIG.COLLECTIONS.PROJECT_CONTACTS;
const PROJ_COL = CONFIG.COLLECTIONS.PROJECTS;

async function ensureProjectContactLink(env, projectId, contactId) {
  const existing = await queryDocs(env, LINK_COL, {
    where: [{ field: 'project_id', value: projectId }, { field: 'contact_id', value: contactId }],
    limit: 1
  });
  if (existing.length > 0) return;

  await addDoc(env, LINK_COL, { project_id: projectId, contact_id: contactId, date_linked: new Date() });
}

async function createContact(env, user, data) {
  validateCreateContact(data);

  const project = await getDoc(env, PROJ_COL, data.project_id);
  if (!project) throwError('Project tidak ditemukan: ' + data.project_id, 'not-found');
  requireOwnership(user, project.sales_uid);

  if (data.contact_id) {
    const existing = await getDoc(env, CONTACT_COL, data.contact_id);
    if (existing) {
      await ensureProjectContactLink(env, data.project_id, data.contact_id);
      return successResponse({ contact_id: data.contact_id }, 'Contact sudah tersimpan sebelumnya');
    }
  }

  const contactId = data.contact_id || (await generateUniqueId(generateContactId, env, CONTACT_COL));
  const now = new Date();

  const newContact = {
    contact_name: data.contact_name,
    phone_number: data.phone_number,
    role: data.role,
    company_affiliation: data.company_affiliation || '',
    personal_note: data.personal_note || '',
    business_id: user.business_id,
    date_created: now
  };

  await setDoc(env, CONTACT_COL, contactId, newContact);
  await ensureProjectContactLink(env, data.project_id, contactId);

  return successResponse({ contact_id: contactId }, 'Contact berhasil disimpan');
}

async function readContactsSummary(env, user) {
  const links = await queryDocs(env, LINK_COL, {});

  const summary = {};
  const seenProjects = new Set();

  // Ambil kontak pertama per project saja (kontak utama), sesuai urutan link tersimpan
  const relevantLinks = links.filter((l) => {
    if (seenProjects.has(l.project_id)) return false;
    seenProjects.add(l.project_id);
    return true;
  });

  const contacts = await Promise.all(relevantLinks.map((l) => getDoc(env, CONTACT_COL, l.contact_id)));

  relevantLinks.forEach((l, i) => {
    if (contacts[i]) {
      summary[l.project_id] = { contact_name: contacts[i].contact_name, role: contacts[i].role };
    }
  });

  return successResponse(summary, 'Ringkasan kontak per project');
}

async function readProjectContacts(env, user, data) {
  validateRequiredFields(data, ['project_id']);

  const links = await queryDocs(env, LINK_COL, { where: [{ field: 'project_id', value: data.project_id }] });
  if (links.length === 0) return successResponse([], '0 contact ditemukan');

  const contacts = await Promise.all(links.map((l) => getDoc(env, CONTACT_COL, l.contact_id)));
  const results = contacts.filter(Boolean).map((c) => ({ contact_id: c.id, ...c }));

  return successResponse(results, results.length + ' contact ditemukan');
}

module.exports = { createContact, readContactsSummary, readProjectContacts };
