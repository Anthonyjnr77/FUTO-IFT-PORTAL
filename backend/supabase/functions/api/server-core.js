import http from 'node:http';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { COURSE_CATALOG } from './curriculum.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const Pool = pg.Pool;
// The Edge adapter supplies its runtime configuration without mutating process.env.
const ENV = globalThis.__FUTO_PORTAL_ENV__ || process.env;
const PORT = Number(ENV.PORT || 3000);
const DATA_DIR = ENV.PORTAL_DATA_DIR || path.join(BACKEND_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const RESET_MARKER_FILE = path.join(DATA_DIR, '.reset-complete');
const CLIENT_URL = ENV.CLIENT_URL || 'http://localhost:3000';
const CLIENT_ORIGINS = new Set([
  CLIENT_URL,
  ...(ENV.ADDITIONAL_CLIENT_URLS || '').split(',').map(origin => origin.trim()).filter(Boolean)
]);
const DATABASE_URL = ENV.DATABASE_URL || '';
const SUPABASE_URL = (ENV.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = 'course-materials';
const requestContext = new AsyncLocalStorage();
const responseOrigins = new WeakMap();
let databasePool = null;

if (ENV.NODE_ENV === 'production' && !ENV.CLIENT_URL) {
  throw new Error('CLIENT_URL must be configured in production.');
}
if (ENV.NODE_ENV === 'production') {
  let clientOrigin;
  try {
    clientOrigin = new URL(ENV.CLIENT_URL);
  } catch {
    throw new Error('CLIENT_URL must be a valid HTTPS origin in production.');
  }
  if (clientOrigin.protocol !== 'https:' || clientOrigin.origin !== ENV.CLIENT_URL.replace(/\/+$/, '')) {
    throw new Error('CLIENT_URL must be a valid HTTPS origin in production.');
  }
  if (!DATABASE_URL) throw new Error('Configure Supabase DATABASE_URL before running the production backend.');
  if (!ENV.SMTP_HOST || !ENV.SMTP_USER || !ENV.SMTP_PASS) {
    throw new Error('Configure SMTP_HOST, SMTP_USER, and SMTP_PASS before running the production backend.');
  }
}

const mailTransport = ENV.SMTP_HOST && nodemailer ? nodemailer.createTransport({
  host: ENV.SMTP_HOST,
  port: Number(ENV.SMTP_PORT || 587),
  secure: ENV.SMTP_SECURE === 'true',
  auth: { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS }
}) : null;

async function sendMail({ to, subject, text }) {
  if (ENV.SMTP_HOST && !nodemailer) throw new Error('Install backend dependencies with npm install before enabling SMTP.');
  if (!mailTransport) {
    if (ENV.NODE_ENV === 'production') throw new Error('Email delivery is not configured.');
    console.log(`[email preview] To: ${to}\nSubject: ${subject}\n${text}`);
    return;
  }
  await mailTransport.sendMail({ from: ENV.MAIL_FROM || ENV.SMTP_USER, to, subject, text });
}

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
  if (ENV.RESET_DATABASE_ONCE === 'true' && !fs.existsSync(RESET_MARKER_FILE)) {
    writeDatabase({ users: [], quizResults: [] });
    fs.writeFileSync(RESET_MARKER_FILE, new Date().toISOString());
  }
  if (!fs.existsSync(DATA_FILE)) {
    writeDatabase({ users: [], quizResults: [] });
  }
  const database = readDatabase();
  const changed = normalizeDatabase(database);
  const adminCreated = ensureBootstrapAdmin(database);
  if (changed || adminCreated) writeDatabase(database);
}

function createEmptyDatabase() {
  return { users: [], quizResults: [] };
}

function ensureCourseCatalog(database) {
  let changed = false;
  COURSE_CATALOG.forEach(entry => {
    const id = `curriculum-${entry.level}-${entry.semester.toLowerCase()}-${entry.courseCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const course = database.taughtCourses.find(candidate =>
      candidate.id === id ||
      (candidate.courseCode === entry.courseCode && candidate.level === entry.level &&
        (!candidate.semester || candidate.semester === entry.semester))
    );
    const catalogFields = {
      ...entry,
      catalogManaged: true,
      lecturerId: course ? course.lecturerId || null : null
    };
    if (course) {
      if (course.id !== id && !course.semester) catalogFields.id = course.id;
      if (Object.keys(catalogFields).some(key => course[key] !== catalogFields[key])) {
        Object.assign(course, catalogFields);
        changed = true;
      }
      return;
    }
    database.taughtCourses.push({
      ...catalogFields,
      id,
      day: '',
      startTime: '',
      endTime: '',
      room: '',
      createdAt: new Date().toISOString()
    });
    changed = true;
  });
  return changed;
}

function normalizeDatabase(database) {
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new Error('Database state has an invalid format.');
  }
  let changed = false;
  for (const key of [
    'users', 'quizResults', 'assignments', 'assignmentSubmissions', 'taughtCourses', 'quizzes',
    'quizAttempts', 'courseEnrollments', 'notifications', 'courseAnnouncements', 'courseMaterials',
    'progressLogs', 'readingProgress', 'pastQuestions', 'chatLogs', 'chatIntents',
    'rememberedSessions', 'sessions'
  ]) {
    if (!Array.isArray(database[key])) {
      database[key] = [];
      changed = true;
    }
  }
  changed = ensureCourseCatalog(database) || changed;
  return changed;
}

function ensureBootstrapAdmin(database) {
  const username = (ENV.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = ENV.ADMIN_PASSWORD || '';
  if (!username && !password) return false;
  if (username.length < 3 || password.length < 12) {
    throw new Error('Configure both ADMIN_USERNAME (at least 3 characters) and ADMIN_PASSWORD (at least 12 characters) to provision the initial administrator.');
  }
  const email = (ENV.ADMIN_EMAIL || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid email address.');
  const existing = database.users.find(user => user.role === 'admin' && user.identifier === username);
  if (existing) return false;
  if (database.users.some(user => user.identifier === username || (email && user.email === email))) {
    throw new Error('The configured administrator username or email is already assigned to another account.');
  }
  database.users.push({
    id: crypto.randomUUID(),
    identifier: username,
    ...(email ? { email } : {}),
    name: ENV.ADMIN_NAME || 'Portal Administrator',
    role: 'admin',
    isActive: true,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  });
  return true;
}

function readDatabase() {
  const context = requestContext.getStore();
  if (context) return context.database;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    throw new Error('Database could not be read.');
  }
}

function writeDatabase(database) {
  const context = requestContext.getStore();
  if (context) {
    if (context.committed) throw new Error('Cannot write portal state after the request transaction has committed.');
    context.database = database;
    context.dirty = true;
    if (context.client) {
      return context.client.query(
        'UPDATE public.portal_state SET state = $1::jsonb, updated_at = now() WHERE id = 1',
        [JSON.stringify(database)]
      );
    }
    return Promise.resolve();
  }
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
  fs.renameSync(temporaryFile, DATA_FILE);
  return undefined;
}

function encodeStoragePath(objectPath) {
  return objectPath.split('/').map(encodeURIComponent).join('/');
}

function storageObjectUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeStoragePath(objectPath)}`;
}

function storageHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
  };
}

async function uploadStorageObject(objectPath, contents, contentType) {
  const response = await fetch(storageObjectUrl(objectPath), {
    method: 'POST',
    headers: {
      ...storageHeaders(),
      'Content-Type': contentType,
      'x-upsert': 'false'
    },
    body: contents
  });
  if (!response.ok) {
    throw new Error(`Course file storage upload failed with status ${response.status}.`);
  }
}

async function downloadStorageObject(objectPath) {
  const response = await fetch(storageObjectUrl(objectPath), {
    method: 'GET',
    headers: storageHeaders()
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Course file storage download failed with status ${response.status}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function initializeSupabaseDatabase() {
  if (!Pool) throw new Error('The PostgreSQL dependency is missing. Run npm install in the backend directory.');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY with DATABASE_URL.');
  }
  let parsedSupabaseUrl;
  try {
    parsedSupabaseUrl = new URL(SUPABASE_URL);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL.');
  }
  if (parsedSupabaseUrl.protocol !== 'https:' || parsedSupabaseUrl.username || parsedSupabaseUrl.password) {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL without embedded credentials.');
  }
  databasePool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    max: Number(ENV.DATABASE_POOL_SIZE || 4),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  databasePool.on('error', error => {
    console.error('Unexpected Supabase PostgreSQL pool error:', error.message);
  });

  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(731942816)');
    const result = await client.query('SELECT state FROM public.portal_state WHERE id = 1 FOR UPDATE');
    const database = result.rows[0]?.state || createEmptyDatabase();
    const stateChanged = normalizeDatabase(database);
    const adminCreated = ensureBootstrapAdmin(database);
    if (!database.users.some(user => user.role === 'admin' && user.isActive !== false)) {
      throw new Error('Configure ADMIN_USERNAME and ADMIN_PASSWORD to provision an active administrator.');
    }
    if (result.rowCount === 0 || stateChanged || adminCreated) {
      await client.query(
        `INSERT INTO public.portal_state (id, state, updated_at)
         VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(database)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function createBufferedResponse(response) {
  const buffered = {
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode, headers) {
      buffered.statusCode = statusCode;
      buffered.headers = headers;
      buffered.headersSent = true;
      return buffered;
    },
    end(body) {
      buffered.body = body;
      buffered.writableEnded = true;
      return buffered;
    },
    flush() {
      if (buffered.headersSent) response.writeHead(buffered.statusCode, buffered.headers);
      response.end(buffered.body);
    }
  };
  return buffered;
}

async function handleSupabaseRequest(request, response) {
  let context = null;
  let client = null;
  const bufferedResponse = createBufferedResponse(response);
  try {
    client = await databasePool.connect();
    context = {
      client,
      database: null,
      dirty: false,
      committed: false,
      origin: request.headers.origin || ''
    };
    await client.query('BEGIN');
    const isWriteRequest = request.method !== 'GET' && request.method !== 'HEAD';
    if (isWriteRequest) await client.query('SELECT pg_advisory_xact_lock(731942816)');
    const result = await client.query(
      isWriteRequest
        ? 'SELECT state FROM public.portal_state WHERE id = 1 FOR UPDATE'
        : 'SELECT state FROM public.portal_state WHERE id = 1'
    );
    if (result.rowCount !== 1) throw new Error('Supabase portal state is missing. Run the database migration first.');
    context.database = result.rows[0].state;
    await requestContext.run(context, () => handleRequest(request, bufferedResponse));
    if (!context.committed) {
      await client.query('COMMIT');
      context.client = null;
      context.committed = true;
    }
    client.release();
    bufferedResponse.flush();
  } catch (error) {
    if (context && context.client) {
      try {
        await context.client.query('ROLLBACK');
      } finally {
        context.client.release();
        context.client = null;
      }
    } else if (client) {
      client.release();
    }
    console.error('Supabase-backed request failed:', error.message);
    if (!response.headersSent && !response.writableEnded) {
      sendJson(response, 503, { error: 'The portal backend is temporarily unavailable. Please try again later.' });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

function sendJson(response, statusCode, body) {
  const requestOrigin = requestContext.getStore()?.origin || responseOrigins.get(response) || '';
  const allowedOrigin = getAllowedClientOrigin(requestOrigin);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  response.end(JSON.stringify(body));
}

function getAllowedClientOrigin(origin) {
  return CLIENT_ORIGINS.has(origin) || isLocalDevelopmentOrigin(origin) ? origin : CLIENT_URL;
}

function isLocalDevelopmentOrigin(origin) {
  if (ENV.NODE_ENV === 'production' || !origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
      parsed.origin === origin;
  } catch {
    return false;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 6_000_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  const [salt, storedHash] = storedPassword.split(':');
  const candidateHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function publicUser(user) {
  const { passwordHash, resetTokenHash, resetTokenExpiresAt, passwordResetRequired, ...safeUser } = user;
  return safeUser;
}

function validateCredentials(payload, role) {
  const identifier = role === 'student' ? payload.matric : (payload.username || payload.email);
  if (typeof identifier !== 'string' || identifier.trim().length < 3) return 'A valid username is required.';
  if (role === 'student' && !/^202\d{8}$/.test(identifier.trim())) return 'Matric number must match 202XXXXXXXX.';
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim())) return 'Please enter a valid email address.';
  if (typeof payload.password !== 'string' || payload.password.length < 6) return 'Password must be at least 6 characters.';
  return null;
}

function createResetToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash, expiresAt: Date.now() + 30 * 60 * 1000 };
}

async function createSession(user, database, rememberMe) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  database.sessions = database.sessions.filter(item => item.expiresAt >= Date.now());
  database.sessions.push({ tokenHash, userId: user.id, expiresAt });
  if (rememberMe) {
    database.rememberedSessions = database.rememberedSessions.filter(item => item.expiresAt >= Date.now());
    database.rememberedSessions.push({
      tokenHash,
      userId: user.id,
      expiresAt
    });
  }
  await writeDatabase(database);
  return token;
}

function authenticatedUser(request, database) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = database.sessions.find(item => item.tokenHash === tokenHash && item.expiresAt >= Date.now());
  if (session) {
    const user = database.users.find(candidate => candidate.id === session.userId);
    return user && user.isActive !== false ? user : null;
  }
  const remembered = database.rememberedSessions.find(item => item.tokenHash === tokenHash && item.expiresAt >= Date.now());
  if (!remembered) return null;
  const user = database.users.find(candidate => candidate.id === remembered.userId);
  return user && user.isActive !== false ? user : null;
}

function revokeUserSessions(database, userId) {
  database.sessions = database.sessions.filter(session => session.userId !== userId);
  database.rememberedSessions = database.rememberedSessions.filter(item => item.userId !== userId);
}

function routeKey(request) {
  return `${request.method} ${new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname}`;
}

  function assignmentForStudent(assignment, database, studentId) {
    const submission = database.assignmentSubmissions.find(item => item.assignmentId === assignment.id && item.studentId === studentId);
    return { ...assignment, submission: submission || null };
  }

function studentEnrolled(database, studentId, courseId) {
  return database.courseEnrollments.some(enrollment => enrollment.studentId === studentId && enrollment.courseId === courseId);
}

function topicTokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function topicMatchScore(query, material) {
  const stopWords = new Set([
    'about', 'after', 'again', 'also', 'and', 'are', 'can', 'could', 'does', 'explain',
    'find', 'for', 'from', 'help', 'how', 'into', 'is', 'me', 'on', 'please', 'show',
    'summarise', 'summarize', 'summary', 'tell', 'the', 'this', 'what', 'with'
  ]);
  const queryTerms = [...new Set(topicTokens(query).filter(token => token.length > 2 && !stopWords.has(token)))];
  if (!queryTerms.length) return 0;
  const resourceTerms = new Set(topicTokens([
    material.courseCode, material.courseTitle, material.topicTag, material.title,
    material.fileName, material.searchText || ''
  ].join(' ')));
  const matchingTerms = queryTerms.filter(token => resourceTerms.has(token));
  return matchingTerms.length / queryTerms.length;
}

function normalizedCourseCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function requestedCourseCode(query) {
  const match = String(query || '').match(/\b([a-z]{2,5})\s*(\d{3})\b/i);
  return match ? normalizedCourseCode(match[1] + match[2]) : '';
}

function isSummaryQuery(query) {
  return /\b(summar(?:y|ize|ise)|overview|give me the gist|key points|what is this|what's this|tell me about)\b/i.test(query);
}

function isDocumentHelpQuery(query) {
  return /\b(i have a question|i've got a question|question on this|ask a question|help me with this|about this)\b/i.test(query);
}

function pdfTextPages(searchText) {
  const pages = [];
  const pagePattern = /\[page\s+(\d+)\]\s*([\s\S]*?)(?=\[page\s+\d+\]|$)/gi;
  let match;
  while ((match = pagePattern.exec(String(searchText || ''))) !== null) {
    const text = match[2].trim();
    if (text) pages.push({ number: Number(match[1]), text });
  }
  if (!pages.length && String(searchText || '').trim()) {
    pages.push({ number: 1, text: String(searchText).trim() });
  }
  return pages;
}

function pdfSentences(searchText) {
  return pdfTextPages(searchText).flatMap(page => {
    const sentences = page.text.match(/[^.!?]+(?:\.(?=\d)[^.!?]+)*[.!?]?/g) || [];
    return sentences
      .map(text => text.replace(/\s+/g, ' ').trim())
      .filter(text => text.length >= 20)
      .map(text => ({ text, page: page.number }));
  });
}

function rankPdfSentences(query, sentences) {
  const stopWords = new Set([
    'about', 'after', 'again', 'also', 'and', 'are', 'can', 'could', 'does', 'explain',
    'find', 'for', 'from', 'help', 'how', 'into', 'is', 'me', 'on', 'please', 'show',
    'summarise', 'summarize', 'summary', 'tell', 'the', 'this', 'what', 'with'
  ]);
  const queryTerms = [...new Set(topicTokens(query).filter(token => token.length > 2 && !stopWords.has(token)))];
  if (!queryTerms.length) return [];
  return sentences.map((sentence, index) => {
    const sentenceTerms = new Set(topicTokens(sentence.text));
    const matches = queryTerms.filter(term => sentenceTerms.has(term));
    return {
      ...sentence,
      index,
      score: matches.length / queryTerms.length
    };
  }).filter(sentence => sentence.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

function summarizePdf(searchText) {
  const sentences = pdfSentences(searchText);
  if (!sentences.length) return '';
  const termCounts = new Map();
  sentences.forEach(sentence => {
    new Set(topicTokens(sentence.text).filter(term => term.length > 3)).forEach(term => {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    });
  });
  const ranked = sentences.map((sentence, index) => {
    const terms = topicTokens(sentence.text).filter(term => term.length > 3);
    const score = terms.reduce((sum, term) => sum + 1 / (termCounts.get(term) || 1), 0) /
      Math.max(terms.length, 1);
    return { ...sentence, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  for (const sentence of ranked) {
    if (selected.every(item => item.text !== sentence.text)) selected.push(sentence);
    if (selected.length === 4) break;
  }
  return selected.sort((a, b) => a.index - b.index)
    .map(sentence => `${sentence.text} [p. ${sentence.page}]`)
    .join(' ');
}

function chatIntentScore(query, intent) {
  return topicMatchScore(query, {
    topicTag: intent.topicTag,
    title: Array.isArray(intent.samplePhrases) ? intent.samplePhrases.join(' ') : '',
    fileName: intent.explanation || ''
  });
}

function notifyEnrolledStudents(database, courseId, { title, body, type, referenceId }) {
  database.courseEnrollments
    .filter(enrollment => enrollment.courseId === courseId)
    .forEach(enrollment => database.notifications.unshift({
      id: crypto.randomUUID(), userId: enrollment.studentId, courseId,
      title, body, type, referenceId, readAt: null, createdAt: new Date().toISOString()
    }));
}

function serveClientFile(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname);
  const projectRoot = path.resolve(BACKEND_ROOT, '..');
  const frontendRoot = path.join(projectRoot, 'frontend');
  let filePath;
  if (pathname === '/404.html') {
    filePath = path.join(projectRoot, '404.html');
  } else if (pathname === '/') {
    filePath = path.join(frontendRoot, 'pages', 'index.html');
  } else if (pathname.startsWith('/assets/')) {
    filePath = path.resolve(frontendRoot, 'assets', pathname.slice('/assets/'.length));
    if (!filePath.startsWith(path.join(frontendRoot, 'assets') + path.sep)) return false;
  } else {
    filePath = path.resolve(frontendRoot, 'pages', pathname.replace(/^\/+/, ''));
    if (!filePath.startsWith(path.join(frontendRoot, 'pages') + path.sep)) return false;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  response.end(fs.readFileSync(filePath));
  return true;
}

async function handleRequest(request, response) {
  if (request.method === 'OPTIONS') return sendJson(response, 204, {});
  if (request.method === 'GET' && !request.url.startsWith('/api/') && serveClientFile(request, response)) return;
  const database = readDatabase();

  if (routeKey(request) === 'GET /api/health') return sendJson(response, 200, { status: 'ok', service: 'futo-ift-api' });

  const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  if (pathname === '/api/admin/chat-intents' && request.method === 'GET') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const materials = database.courseMaterials.map(({ storageName, ...material }) => material);
    const intents = database.chatIntents.map(intent => ({
      ...intent,
      material: materials.find(material => material.id === intent.linkedMaterialId) || null
    }));
    return sendJson(response, 200, { intents, materials });
  }

  if (pathname === '/api/admin/chat-intents' && request.method === 'POST') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const payload = await readBody(request);
    const topicTag = typeof payload.topicTag === 'string' ? payload.topicTag.trim() : '';
    const explanation = typeof payload.explanation === 'string' ? payload.explanation.trim() : '';
    const linkedMaterialId = typeof payload.linkedMaterialId === 'string' ? payload.linkedMaterialId : '';
    const samplePhrases = Array.isArray(payload.samplePhrases)
      ? [...new Set(payload.samplePhrases.map(phrase => typeof phrase === 'string' ? phrase.trim() : '').filter(Boolean))]
      : [];
    const linkedMaterial = database.courseMaterials.find(material => material.id === linkedMaterialId);
    if (topicTag.length < 2 || topicTag.length > 100 || !explanation || explanation.length > 500 ||
      samplePhrases.length < 1 || samplePhrases.length > 12 ||
      samplePhrases.some(phrase => phrase.length < 3 || phrase.length > 180) || !linkedMaterial) {
      return sendJson(response, 400, { error: 'Provide a topic, explanation, 1–12 sample phrases, and an existing linked course resource.' });
    }
    const now = new Date().toISOString();
    const intent = { id: crypto.randomUUID(), topicTag, explanation, samplePhrases, linkedMaterialId, createdAt: now, updatedAt: now };
    database.chatIntents.unshift(intent);
    await writeDatabase(database);
    return sendJson(response, 201, { intent });
  }

  const chatIntentPath = pathname.match(/^\/api\/admin\/chat-intents\/([^/]+)$/);
  if (chatIntentPath && (request.method === 'POST' || request.method === 'DELETE')) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const intentIndex = database.chatIntents.findIndex(intent => intent.id === chatIntentPath[1]);
    if (intentIndex < 0) return sendJson(response, 404, { error: 'Chatbot intent not found.' });
    if (request.method === 'DELETE') {
      const [intent] = database.chatIntents.splice(intentIndex, 1);
      await writeDatabase(database);
      return sendJson(response, 200, { deleted: true, id: intent.id });
    }
    const payload = await readBody(request);
    const topicTag = typeof payload.topicTag === 'string' ? payload.topicTag.trim() : '';
    const explanation = typeof payload.explanation === 'string' ? payload.explanation.trim() : '';
    const linkedMaterialId = typeof payload.linkedMaterialId === 'string' ? payload.linkedMaterialId : '';
    const samplePhrases = Array.isArray(payload.samplePhrases)
      ? [...new Set(payload.samplePhrases.map(phrase => typeof phrase === 'string' ? phrase.trim() : '').filter(Boolean))]
      : [];
    if (topicTag.length < 2 || topicTag.length > 100 || !explanation || explanation.length > 500 ||
      samplePhrases.length < 1 || samplePhrases.length > 12 ||
      samplePhrases.some(phrase => phrase.length < 3 || phrase.length > 180) ||
      !database.courseMaterials.some(material => material.id === linkedMaterialId)) {
      return sendJson(response, 400, { error: 'Provide a topic, explanation, 1–12 sample phrases, and an existing linked course resource.' });
    }
    const intent = database.chatIntents[intentIndex];
    intent.topicTag = topicTag;
    intent.explanation = explanation;
    intent.samplePhrases = samplePhrases;
    intent.linkedMaterialId = linkedMaterialId;
    intent.updatedAt = new Date().toISOString();
    await writeDatabase(database);
    return sendJson(response, 200, { intent });
  }

  if (pathname === '/api/admin/users' && request.method === 'GET') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const users = database.users
      .slice()
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map(candidate => ({ ...publicUser(candidate), isActive: candidate.isActive !== false }));
    return sendJson(response, 200, { users });
  }

  if (pathname === '/api/admin/users' && request.method === 'POST') {
    const admin = authenticatedUser(request, database);
    if (!admin || admin.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const payload = await readBody(request);
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const role = payload.role;
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const identifier = typeof payload.identifier === 'string' ? payload.identifier.trim().toLowerCase() : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    const level = String(payload.level || '');
    const validRole = ['student', 'lecturer', 'admin'].includes(role);
    const validIdentifier = role === 'student' ? /^202\d{8}$/.test(identifier) : identifier.length >= 3 && identifier.length <= 80;
    if (!validRole || name.length < 3 || name.length > 100 || !validIdentifier ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 ||
      (role === 'student' && !['100', '200', '300', '400', '500'].includes(level))) {
      return sendJson(response, 400, { error: 'Provide a valid name, email, role, identifier, and password (at least 12 characters); students also need a valid matric number and level.' });
    }
    if (database.users.some(candidate => candidate.identifier === identifier || candidate.email === email)) {
      return sendJson(response, 409, { error: 'That username, matric number, or email is already assigned.' });
    }
    const createdUser = {
      id: crypto.randomUUID(), identifier, email, name, role,
      ...(role === 'student' ? { dept: 'IFT', level } : {}),
      isActive: true, passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    };
    database.users.push(createdUser);
    await writeDatabase(database);
    return sendJson(response, 201, { user: { ...publicUser(createdUser), isActive: true } });
  }

  const adminUserPath = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(role|status)$/);
  if (adminUserPath && request.method === 'POST') {
    const admin = authenticatedUser(request, database);
    if (!admin || admin.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const target = database.users.find(candidate => candidate.id === adminUserPath[1]);
    if (!target) return sendJson(response, 404, { error: 'User not found.' });
    if (target.id === admin.id) return sendJson(response, 409, { error: 'You cannot change your own role or account status.' });
    const payload = await readBody(request);
    if (adminUserPath[2] === 'role') {
      const role = payload.role;
      if (!['student', 'lecturer', 'admin'].includes(role)) return sendJson(response, 400, { error: 'Choose a valid account role.' });
      if (target.role === 'admin' && role !== 'admin' &&
        database.users.filter(candidate => candidate.role === 'admin' && candidate.isActive !== false).length <= 1) {
        return sendJson(response, 409, { error: 'The final active administrator cannot be demoted.' });
      }
      target.role = role;
      revokeUserSessions(database, target.id);
    } else {
      if (typeof payload.isActive !== 'boolean') return sendJson(response, 400, { error: 'Account status must be active or inactive.' });
      if (!payload.isActive && target.role === 'admin' &&
        database.users.filter(candidate => candidate.role === 'admin' && candidate.isActive !== false).length <= 1) {
        return sendJson(response, 409, { error: 'The final active administrator cannot be disabled.' });
      }
      target.isActive = payload.isActive;
      if (!target.isActive) revokeUserSessions(database, target.id);
    }
    await writeDatabase(database);
    return sendJson(response, 200, { user: { ...publicUser(target), isActive: target.isActive !== false } });
  }

  if (request.method === 'GET' && pathname === '/api/lecturer/courses') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const weekdayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const courses = database.taughtCourses
      .filter(course => course.lecturerId === user.id)
      .sort((a, b) => weekdayOrder.indexOf(a.day) - weekdayOrder.indexOf(b.day) || a.startTime.localeCompare(b.startTime));
    return sendJson(response, 200, { courses });
  }

  if (request.method === 'GET' && pathname === '/api/curriculum') {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const courses = database.taughtCourses
      .filter(course => course.catalogManaged)
      .map(course => ({
        id: course.id,
        courseCode: course.courseCode,
        courseTitle: course.courseTitle,
        level: course.level,
        semester: course.semester,
        units: course.units,
        electiveGroup: course.electiveGroup || null,
        enrolled: user.role === 'student' && studentEnrolled(database, user.id, course.id)
      }))
      .sort((a, b) =>
        Number(a.level) - Number(b.level) ||
        a.semester.localeCompare(b.semester) ||
        a.courseCode.localeCompare(b.courseCode)
      );
    return sendJson(response, 200, { courses });
  }

  if (request.method === 'GET' && pathname === '/api/courses') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const lecturersById = new Map(database.users.map(candidate => [candidate.id, candidate]));
    const courses = database.taughtCourses
      .filter(course => course.level === String(user.level || ''))
      .map(course => ({
        ...course,
        lecturerName: (lecturersById.get(course.lecturerId) || {}).name || 'Unassigned',
        enrolled: studentEnrolled(database, user.id, course.id)
      }))
      .sort((a, b) => a.semester?.localeCompare(b.semester || '') || a.courseCode.localeCompare(b.courseCode));
    return sendJson(response, 200, { courses });
  }

  const enrollmentPath = pathname.match(/^\/api\/courses\/([^/]+)\/enroll$/);
  if (request.method === 'POST' && enrollmentPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const course = database.taughtCourses.find(item => item.id === enrollmentPath[1]);
    if (!course || course.level !== String(user.level || '')) return sendJson(response, 404, { error: 'This course is not available for your registered level.' });
    if (course.electiveGroup) {
      const existingElective = database.taughtCourses.find(candidate =>
        candidate.electiveGroup === course.electiveGroup &&
        studentEnrolled(database, user.id, candidate.id)
      );
      if (existingElective && existingElective.id !== course.id) {
        return sendJson(response, 409, { error: `You have already registered for ${existingElective.courseCode}. Choose only one course in this elective group.` });
      }
    }
    if (!studentEnrolled(database, user.id, course.id)) {
      database.courseEnrollments.push({ studentId: user.id, courseId: course.id, enrolledAt: new Date().toISOString() });
      await writeDatabase(database);
    }
    return sendJson(response, 200, { enrolled: true, courseId: course.id });
  }

  if (request.method === 'GET' && pathname === '/api/notifications') {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const notifications = database.notifications
      .filter(notification => notification.userId === user.id && (user.role !== 'student' || !notification.courseId || studentEnrolled(database, user.id, notification.courseId)))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(response, 200, { notifications, unreadCount: notifications.filter(item => !item.readAt).length });
  }

  if (pathname === '/api/past-questions' && request.method === 'GET') {
    const user = authenticatedUser(request, database);
    if (!user || !['admin', 'lecturer'].includes(user.role)) {
      return sendJson(response, 401, { error: 'Lecturer or administrator authentication required.' });
    }
    const courses = database.taughtCourses.filter(course => user.role === 'admin' || course.lecturerId === user.id);
    const courseIds = new Set(courses.map(course => course.id));
    const pastQuestions = database.pastQuestions
      .filter(item => courseIds.has(item.courseId))
      .sort((a, b) => b.examYear - a.examYear || a.courseCode.localeCompare(b.courseCode));
    return sendJson(response, 200, { pastQuestions, courses });
  }

  if (pathname === '/api/past-questions' && request.method === 'POST') {
    const user = authenticatedUser(request, database);
    if (!user || !['admin', 'lecturer'].includes(user.role)) {
      return sendJson(response, 401, { error: 'Lecturer or administrator authentication required.' });
    }
    const payload = await readBody(request);
    const course = database.taughtCourses.find(item =>
      item.id === payload.courseId && (user.role === 'admin' || item.lecturerId === user.id)
    );
    const questionText = typeof payload.questionText === 'string' ? payload.questionText.trim() : '';
    const topicTag = typeof payload.topicTag === 'string' ? payload.topicTag.trim() : '';
    const examYear = Number(payload.examYear);
    const currentYear = new Date().getFullYear();
    if (!course || questionText.length < 10 || questionText.length > 3000 ||
      topicTag.length < 2 || topicTag.length > 100 ||
      !Number.isInteger(examYear) || examYear < 1950 || examYear > currentYear) {
      return sendJson(response, 400, { error: 'Choose an authorized course and provide a question (10–3,000 characters), topic tag, and valid past exam year.' });
    }
    const pastQuestion = {
      id: crypto.randomUUID(),
      courseId: course.id,
      courseCode: course.courseCode,
      courseTitle: course.courseTitle,
      lecturerId: user.id,
      questionText,
      topicTag,
      examYear,
      createdAt: new Date().toISOString()
    };
    database.pastQuestions.unshift(pastQuestion);
    await writeDatabase(database);
    return sendJson(response, 201, { pastQuestion });
  }

  const pastQuestionPath = pathname.match(/^\/api\/past-questions\/([^/]+)$/);
  if (pastQuestionPath && request.method === 'DELETE') {
    const user = authenticatedUser(request, database);
    if (!user || !['admin', 'lecturer'].includes(user.role)) {
      return sendJson(response, 401, { error: 'Lecturer or administrator authentication required.' });
    }
    const index = database.pastQuestions.findIndex(item =>
      item.id === pastQuestionPath[1] && (user.role === 'admin' || item.lecturerId === user.id)
    );
    if (index < 0) return sendJson(response, 404, { error: 'Past question not found.' });
    const [deleted] = database.pastQuestions.splice(index, 1);
    await writeDatabase(database);
    return sendJson(response, 200, { deleted: true, id: deleted.id });
  }

  const notificationReadPath = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (request.method === 'POST' && notificationReadPath) {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const notification = database.notifications.find(item => item.id === notificationReadPath[1] && item.userId === user.id);
    if (!notification) return sendJson(response, 404, { error: 'Notification not found.' });
    notification.readAt = notification.readAt || new Date().toISOString();
    await writeDatabase(database);
    return sendJson(response, 200, { notification });
  }

  if (request.method === 'POST' && pathname === '/api/lecturer/courses') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const payload = await readBody(request);
    const courseCode = typeof payload.courseCode === 'string' ? payload.courseCode.trim().toUpperCase() : '';
    const courseTitle = typeof payload.courseTitle === 'string' ? payload.courseTitle.trim() : '';
    const level = String(payload.level || '');
    const day = typeof payload.day === 'string' ? payload.day : '';
    const startTime = typeof payload.startTime === 'string' ? payload.startTime : '';
    const endTime = typeof payload.endTime === 'string' ? payload.endTime : '';
    const room = typeof payload.room === 'string' ? payload.room.trim() : '';
    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const timeToMinutes = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : -1;
    if (!courseCode || courseCode.length > 20 || courseTitle.length < 3 || courseTitle.length > 120 || !['100', '200', '300', '400', '500'].includes(level) || !validDays.includes(day) || timeToMinutes(startTime) < 0 || timeToMinutes(endTime) <= timeToMinutes(startTime) || room.length > 80) {
      return sendJson(response, 400, { error: 'Provide a valid course, level, day, time range, and room.' });
    }
    const catalogCourse = database.taughtCourses.find(course =>
      course.catalogManaged && course.courseCode === courseCode && course.level === level
    );
    if (catalogCourse) {
      if (catalogCourse.lecturerId && catalogCourse.lecturerId !== user.id) {
        return sendJson(response, 409, { error: 'This catalog course is already assigned to another lecturer.' });
      }
      Object.assign(catalogCourse, {
        lecturerId: user.id,
        day,
        startTime,
        endTime,
        room
      });
      await writeDatabase(database);
      return sendJson(response, 201, { course: catalogCourse });
    }
    const course = {
      id: crypto.randomUUID(), lecturerId: user.id, courseCode, courseTitle, level,
      day, startTime, endTime, room, createdAt: new Date().toISOString()
    };
    database.taughtCourses.unshift(course);
    await writeDatabase(database);
    return sendJson(response, 201, { course });
  }

  const rosterPath = pathname.match(/^\/api\/lecturer\/courses\/([^/]+)\/students(?:\/([^/]+))?$/);
  if (rosterPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const course = database.taughtCourses.find(item => item.id === rosterPath[1] && item.lecturerId === user.id);
    if (!course) return sendJson(response, 404, { error: 'Course not found.' });

    if (request.method === 'GET' && !rosterPath[2]) {
      const studentsById = new Map(database.users.map(candidate => [candidate.id, candidate]));
      const students = database.courseEnrollments
        .filter(enrollment => enrollment.courseId === course.id)
        .map(enrollment => {
          const student = studentsById.get(enrollment.studentId) || {};
          return {
            id: student.id,
            name: student.name || 'Student',
            matric: student.identifier || '',
            level: student.level || '',
            enrolledAt: enrollment.enrolledAt
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(response, 200, { course: { id: course.id, courseCode: course.courseCode, courseTitle: course.courseTitle }, students });
    }

    if (request.method === 'POST' && !rosterPath[2]) {
      const payload = await readBody(request);
      const matric = typeof payload.matric === 'string' ? payload.matric.trim().toLowerCase() : '';
      const student = database.users.find(candidate => candidate.role === 'student' && candidate.identifier === matric);
      if (!student || student.level !== course.level) return sendJson(response, 404, { error: 'No student with that matric number is registered at this course level.' });
      if (!studentEnrolled(database, student.id, course.id)) {
        database.courseEnrollments.push({ studentId: student.id, courseId: course.id, enrolledAt: new Date().toISOString(), addedBy: user.id });
        await writeDatabase(database);
      }
      return sendJson(response, 200, { enrolled: true, student: { id: student.id, name: student.name, matric: student.identifier, level: student.level } });
    }

    if (request.method === 'DELETE' && rosterPath[2]) {
      const studentId = decodeURIComponent(rosterPath[2]);
      const existingCount = database.courseEnrollments.length;
      database.courseEnrollments = database.courseEnrollments.filter(enrollment => !(enrollment.courseId === course.id && enrollment.studentId === studentId));
      if (database.courseEnrollments.length !== existingCount) await writeDatabase(database);
      return sendJson(response, 200, { removed: database.courseEnrollments.length !== existingCount });
    }
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  if (request.method === 'GET' && pathname === '/api/announcements') {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const announcements = database.courseAnnouncements
      .filter(item => user.role === 'lecturer' ? item.lecturerId === user.id : studentEnrolled(database, user.id, item.courseId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(response, 200, { announcements });
  }

  if (request.method === 'POST' && pathname === '/api/lecturer/announcements') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const payload = await readBody(request);
    const course = database.taughtCourses.find(item => item.id === payload.courseId && item.lecturerId === user.id);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (!course || title.length < 3 || title.length > 160 || !body || body.length > 5000) {
      return sendJson(response, 400, { error: 'Choose one of your courses and provide a title and message.' });
    }
    const announcement = {
      id: crypto.randomUUID(), lecturerId: user.id, lecturerName: user.name,
      courseId: course.id, courseCode: course.courseCode,
      title, body, createdAt: new Date().toISOString()
    };
    database.courseAnnouncements.unshift(announcement);
    notifyEnrolledStudents(database, course.id, {
      title: 'Announcement: ' + title,
      body: course.courseCode + ' · ' + body.slice(0, 220),
      type: 'announcement',
      referenceId: announcement.id
    });
    await writeDatabase(database);
    return sendJson(response, 201, { announcement });
  }

  if (request.method === 'GET' && pathname === '/api/materials') {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const materials = database.courseMaterials
      .filter(item => user.role === 'lecturer' ? item.lecturerId === user.id : studentEnrolled(database, user.id, item.courseId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(({ storageName, searchText, ...item }) => ({
        ...item,
        ...(item.resourceType === 'video' ? {} : { downloadUrl: '/api/materials/' + item.id + '/download' })
      }));
    return sendJson(response, 200, { materials });
  }

  function sanitizePdfSearchText(text) {
    return String(text)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100000);
  }

  async function extractPdfText(buffer) {
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
      const pdf = await loadingTask.promise;
      let fullText = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str || '').join(' ');
        fullText += `\n[page ${p}]\n` + pageText;
        if (fullText.length >= 100000) break;
      }
      if (fullText.trim()) return sanitizePdfSearchText(fullText);
    } catch (e) {
      console.error('PDF extraction failed:', e && e.message ? e.message : e);
    }
    return '';
  }

  if (request.method === 'POST' && pathname === '/api/lecturer/materials') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const payload = await readBody(request);
    const course = database.taughtCourses.find(item => item.id === payload.courseId && item.lecturerId === user.id);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const topicTag = typeof payload.topicTag === 'string' ? payload.topicTag.trim() : '';
    const resourceType = payload.resourceType === 'video' ? 'video' : 'file';
    const fileName = typeof payload.fileName === 'string' ? path.basename(payload.fileName.replace(/\\/g, '/')).replace(/[\r\n"]/g, '') : '';
    const extension = path.extname(fileName).toLowerCase();
    const contentTypes = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain' };
    const encoded = typeof payload.contentBase64 === 'string' ? payload.contentBase64.replace(/^data:[^,]*;base64,/, '') : '';
    let resourceUrl = '';
    if (resourceType === 'video') {
      try {
        const parsedUrl = new URL(typeof payload.resourceUrl === 'string' ? payload.resourceUrl.trim() : '');
        if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('Invalid video URL.');
        resourceUrl = parsedUrl.toString();
      } catch {
        return sendJson(response, 400, { error: 'Provide a valid HTTPS link to the video resource.' });
      }
    } else if (!fileName || !contentTypes[extension] || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      return sendJson(response, 400, { error: 'Upload a PDF, DOC, DOCX, or TXT file.' });
    }
    if (!course || title.length < 3 || title.length > 160 || topicTag.length < 2 || topicTag.length > 100) {
      return sendJson(response, 400, { error: 'Choose a course and provide a title and topic tag.' });
    }
    const id = crypto.randomUUID();
    let storageName;
    let fileBuffer;
    if (resourceType === 'file') {
      fileBuffer = Buffer.from(encoded, 'base64');
      if (!fileBuffer.length || fileBuffer.length > 4 * 1024 * 1024) return sendJson(response, 413, { error: 'Files must be smaller than 4 MB.' });
      storageName = databasePool ? `${course.id}/${id}${extension}` : id + extension;
      if (databasePool) {
        await uploadStorageObject(storageName, fileBuffer, contentTypes[extension]);
      } else {
        fs.writeFileSync(path.join(DATA_DIR, 'uploads', storageName), fileBuffer, { flag: 'wx' });
      }
    }
    const material = {
      id, lecturerId: user.id, lecturerName: user.name,
      courseId: course.id, courseCode: course.courseCode,
      courseTitle: course.courseTitle, level: course.level,
      title, topicTag, resourceType,
      ...(resourceType === 'video'
        ? { resourceUrl }
        : { fileName, contentType: contentTypes[extension], sizeBytes: fileBuffer.length, storageName }),
      createdAt: new Date().toISOString()
    };

    if (resourceType === 'file' && extension === '.pdf' && fileBuffer) {
      material.searchText = await extractPdfText(fileBuffer);
    }

    database.courseMaterials.unshift(material);
    notifyEnrolledStudents(database, course.id, {
      title: 'New course material: ' + title,
      body: course.courseCode + ' · ' + title,
      type: 'material',
      referenceId: material.id
    });
    await writeDatabase(database);
    const { storageName: storedName, searchText, ...publicMaterial } = material;
    return sendJson(response, 201, { material: publicMaterial });
  }

  if (request.method === 'POST' && pathname === '/api/admin/materials') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const payload = await readBody(request);
    const course = database.taughtCourses.find(item => item.id === payload.courseId);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const topicTag = typeof payload.topicTag === 'string' ? payload.topicTag.trim() : '';
    const resourceType = payload.resourceType === 'video' ? 'video' : 'file';
    const fileName = typeof payload.fileName === 'string' ? path.basename(payload.fileName.replace(/\\/g, '/')).replace(/[\r\n"]/g, '') : '';
    const extension = path.extname(fileName).toLowerCase();
    const contentTypes = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain' };
    const encoded = typeof payload.contentBase64 === 'string' ? payload.contentBase64.replace(/^data:[^,]*;base64,/, '') : '';
    let resourceUrl = '';
    if (resourceType === 'video') {
      try {
        const parsedUrl = new URL(typeof payload.resourceUrl === 'string' ? payload.resourceUrl.trim() : '');
        if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('Invalid video URL.');
        resourceUrl = parsedUrl.toString();
      } catch {
        return sendJson(response, 400, { error: 'Provide a valid HTTPS link to the video resource.' });
      }
    } else if (!fileName || !contentTypes[extension] || !encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      return sendJson(response, 400, { error: 'Upload a PDF, DOC, DOCX, or TXT file.' });
    }
    if (!course || title.length < 3 || title.length > 160 || topicTag.length < 2 || topicTag.length > 100) {
      return sendJson(response, 400, { error: 'Choose a course and provide a title and topic tag.' });
    }
    const id = crypto.randomUUID();
    let storageName;
    let fileBuffer;
    if (resourceType === 'file') {
      fileBuffer = Buffer.from(encoded, 'base64');
      if (!fileBuffer.length || fileBuffer.length > 4 * 1024 * 1024) return sendJson(response, 413, { error: 'Files must be smaller than 4 MB.' });
      storageName = databasePool ? `${course.id}/${id}${extension}` : id + extension;
      if (databasePool) {
        await uploadStorageObject(storageName, fileBuffer, contentTypes[extension]);
      } else {
        fs.writeFileSync(path.join(DATA_DIR, 'uploads', storageName), fileBuffer, { flag: 'wx' });
      }
    }
    const linkedLecturer = typeof payload.lecturerId === 'string' ? database.users.find(u => u.id === payload.lecturerId && u.role === 'lecturer') : null;
    const material = {
      id,
      lecturerId: linkedLecturer ? linkedLecturer.id : null,
      lecturerName: linkedLecturer ? linkedLecturer.name : user.name,
      courseId: course.id, courseCode: course.courseCode,
      courseTitle: course.courseTitle, level: course.level,
      title, topicTag, resourceType,
      ...(resourceType === 'video'
        ? { resourceUrl }
        : { fileName, contentType: contentTypes[extension], sizeBytes: fileBuffer.length, storageName }),
      createdAt: new Date().toISOString()
    };

    if (resourceType === 'file' && extension === '.pdf' && fileBuffer) {
      material.searchText = await extractPdfText(fileBuffer);
    }

    database.courseMaterials.unshift(material);
    notifyEnrolledStudents(database, course.id, {
      title: 'New course material: ' + title,
      body: course.courseCode + ' · ' + title,
      type: 'material',
      referenceId: material.id
    });
    await writeDatabase(database);
    const { storageName: storedName, searchText, ...publicMaterial } = material;
    return sendJson(response, 201, { material: publicMaterial });
  }

  if (request.method === 'POST' && pathname === '/api/admin/materials/reindex-pdfs') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'admin') return sendJson(response, 401, { error: 'Administrator authentication required.' });
    const payload = await readBody(request);
    const courseCode = typeof payload.courseCode === 'string' ? payload.courseCode.trim().toUpperCase() : '';
    if (!courseCode) return sendJson(response, 400, { error: 'Provide a course code to re-index its PDF materials.' });
    const courseIds = new Set(database.taughtCourses
      .filter(course => course.courseCode.toUpperCase() === courseCode)
      .map(course => course.id));
    if (!courseIds.size) return sendJson(response, 404, { error: 'Course not found.' });
    const materials = database.courseMaterials.filter(material =>
      courseIds.has(material.courseId) &&
      material.resourceType === 'file' &&
      path.extname(material.fileName || '').toLowerCase() === '.pdf'
    );
    if (!materials.length) return sendJson(response, 404, { error: 'No PDF materials were found for this course.' });

    let indexed = 0;
    let noExtractableText = 0;
    for (const material of materials) {
      let fileBuffer;
      if (databasePool) {
        fileBuffer = await downloadStorageObject(material.storageName);
      } else {
        const filePath = path.join(DATA_DIR, 'uploads', material.storageName);
        if (fs.existsSync(filePath)) fileBuffer = fs.readFileSync(filePath);
      }
      if (!fileBuffer) return sendJson(response, 404, { error: `The stored PDF for material ${material.id} is unavailable.` });
      material.searchText = await extractPdfText(fileBuffer);
      if (material.searchText) indexed++;
      else noExtractableText++;
    }
    await writeDatabase(database);
    return sendJson(response, 200, {
      courseCode,
      processed: materials.length,
      indexed,
      noExtractableText
    });
  }

  const materialDownloadPath = pathname.match(/^\/api\/materials\/([^/]+)\/download$/);
  if (request.method === 'GET' && materialDownloadPath) {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const material = database.courseMaterials.find(item => item.id === materialDownloadPath[1]);
    if (!material) return sendJson(response, 404, { error: 'Material not found.' });
    const allowed = user.role === 'lecturer'
      ? material.lecturerId === user.id
      : studentEnrolled(database, user.id, material.courseId);
    if (!allowed) return sendJson(response, 403, { error: 'Enroll in this course to access its materials.' });
    if (material.resourceType === 'video') return sendJson(response, 400, { error: 'Open the video using its resource link.' });
    let fileBuffer;
    if (databasePool) {
      fileBuffer = await downloadStorageObject(material.storageName);
      if (!fileBuffer) return sendJson(response, 404, { error: 'The stored file is unavailable.' });
    } else {
      const filePath = path.join(DATA_DIR, 'uploads', material.storageName);
      if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'The stored file is unavailable.' });
      fileBuffer = fs.readFileSync(filePath);
    }
    response.writeHead(200, {
      'Content-Type': material.contentType,
      'Content-Length': fileBuffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`,
      'Cache-Control': 'private, no-store',
      'Access-Control-Allow-Origin': getAllowedClientOrigin(requestContext.getStore()?.origin || responseOrigins.get(response) || ''),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Vary': 'Origin'
    });
    return response.end(fileBuffer);
  }

  if (request.method === 'GET' && pathname === '/api/lecturer/quizzes') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const quizzes = database.quizzes
      .filter(quiz => quiz.lecturerId === user.id)
      .map(quiz => ({
        id: quiz.id, courseId: quiz.courseId, title: quiz.title, courseCode: quiz.courseCode,
        topicTag: quiz.topicTag || '', passThreshold: Number.isInteger(quiz.passThreshold) ? quiz.passThreshold : 70,
        durationMinutes: quiz.durationMinutes, questionCount: quiz.questions.length,
        createdAt: quiz.createdAt,
        attemptCount: database.quizResults.filter(result => result.quizId === quiz.id).length
      }));
    return sendJson(response, 200, { quizzes });
  }

  if (request.method === 'POST' && pathname === '/api/lecturer/quizzes') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const payload = await readBody(request);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const topicTag = typeof payload.topicTag === 'string' ? payload.topicTag.trim() : '';
    const passThreshold = Number(payload.passThreshold);
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : '';
    const course = database.taughtCourses.find(item => item.id === courseId && item.lecturerId === user.id);
    const durationMinutes = Number(payload.durationMinutes);
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const validQuestions = questions.length >= 2 && questions.length <= 40 && questions.every(question =>
      question && typeof question.q === 'string' && question.q.trim().length > 0 && question.q.length <= 1000 &&
      Array.isArray(question.opts) && question.opts.length >= 2 && question.opts.length <= 4 &&
      question.opts.every(option => typeof option === 'string' && option.trim().length > 0 && option.length <= 500) &&
      Number.isInteger(question.ans) && question.ans >= 0 && question.ans < question.opts.length &&
      (question.exp === undefined || (typeof question.exp === 'string' && question.exp.length <= 1500))
    );
    if (title.length < 3 || title.length > 120 || topicTag.length < 2 || topicTag.length > 100 || !Number.isInteger(passThreshold) || passThreshold < 0 || passThreshold > 100 || !course || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180 || !validQuestions) {
      return sendJson(response, 400, { error: 'Choose a course, provide a title and topic tag, set a mastery threshold from 0 to 100, a duration from 1 to 180 minutes, and 2 to 40 valid questions.' });
    }
    const quiz = {
      id: crypto.randomUUID(), lecturerId: user.id, lecturerName: user.name,
      title, courseId: course.id, courseCode: course.courseCode,
      courseTitle: course.courseTitle, durationMinutes, topicTag, passThreshold,
      questions: questions.map(question => ({
        q: question.q.trim(),
        opts: question.opts.map(option => option.trim()),
        ans: question.ans,
        exp: typeof question.exp === 'string' ? question.exp.trim() : ''
      })),
      createdAt: new Date().toISOString()
    };
    database.quizzes.unshift(quiz);
    notifyEnrolledStudents(database, course.id, {
      title: 'New quiz: ' + title,
      body: course.courseCode + ' · ' + durationMinutes + ' minute' + (durationMinutes === 1 ? '' : 's'),
      type: 'quiz',
      referenceId: quiz.id
    });
    await writeDatabase(database);
    return sendJson(response, 201, { quiz: { id: quiz.id, title: quiz.title, courseCode: quiz.courseCode, topicTag: quiz.topicTag, passThreshold: quiz.passThreshold, questionCount: quiz.questions.length } });
  }

  const quizResultsPath = pathname.match(/^\/api\/lecturer\/quizzes\/([^/]+)\/results$/);
  if (request.method === 'GET' && quizResultsPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const quiz = database.quizzes.find(item => item.id === quizResultsPath[1] && item.lecturerId === user.id);
    if (!quiz) return sendJson(response, 404, { error: 'Quiz not found.' });
    const attempts = database.quizResults.filter(result => result.quizId === quiz.id);
    const usersById = new Map(database.users.map(candidate => [candidate.id, candidate]));
    const bestByStudent = new Map();
    attempts.forEach(function(attempt) {
      const previous = bestByStudent.get(attempt.userId);
      if (!previous || attempt.score > previous.score) bestByStudent.set(attempt.userId, attempt);
    });
    const leaderboard = [...bestByStudent.values()]
      .map(result => {
        const student = usersById.get(result.userId) || {};
        return {
          name: student.name || 'Student',
          matric: student.identifier || '',
          level: student.level || '',
          score: result.score,
          correct: result.correct,
          total: result.total,
          date: result.date,
          attemptCount: attempts.filter(item => item.userId === result.userId).length
        };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const questionStats = quiz.questions.map((question, questionIndex) => {
      const answered = attempts.filter(result => Array.isArray(result.answers) && result.answers[questionIndex] !== null && result.answers[questionIndex] !== undefined);
      const correct = answered.filter(result => result.answers[questionIndex] === question.ans).length;
      return {
        question: question.q,
        responseCount: answered.length,
        correctCount: correct,
        correctPercent: answered.length ? Math.round(correct / answered.length * 100) : 0
      };
    });
    return sendJson(response, 200, {
      quiz: { id: quiz.id, title: quiz.title, courseCode: quiz.courseCode, topicTag: quiz.topicTag || '', passThreshold: Number.isInteger(quiz.passThreshold) ? quiz.passThreshold : 70 },
      attempts: attempts.length, leaderboard, questionStats
    });
  }

  if (request.method === 'GET' && pathname === '/api/lecturer/topic-performance') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const quizzes = database.quizzes.filter(quiz => quiz.lecturerId === user.id);
    const quizById = new Map(quizzes.map(quiz => [quiz.id, quiz]));
    const groups = new Map();
    database.quizResults.forEach(result => {
      const quiz = quizById.get(result.quizId);
      if (!quiz) return;
      const topicTag = quiz.topicTag || quiz.title;
      const key = quiz.courseId + '|' + topicTag.toLowerCase();
      if (!groups.has(key)) groups.set(key, {
        courseId: quiz.courseId, courseCode: quiz.courseCode, topicTag,
        passThreshold: Number.isInteger(quiz.passThreshold) ? quiz.passThreshold : 70,
        attempts: 0, totalScore: 0, belowThresholdCount: 0
      });
      const summary = groups.get(key);
      summary.attempts += 1;
      summary.totalScore += result.score;
      if (result.score < summary.passThreshold) summary.belowThresholdCount += 1;
    });
    const topics = [...groups.values()].map(summary => ({
      ...summary,
      averageScore: Math.round(summary.totalScore / summary.attempts),
      belowThresholdPercent: Math.round(summary.belowThresholdCount / summary.attempts * 100)
    })).sort((a, b) => a.courseCode.localeCompare(b.courseCode) || a.topicTag.localeCompare(b.topicTag));
    return sendJson(response, 200, { topics });
  }

  if (request.method === 'GET' && pathname === '/api/lecturer/chat-analytics') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const coursesById = new Map(database.taughtCourses
      .filter(course => course.lecturerId === user.id)
      .map(course => [course.id, course]));
    const materialsById = new Map(database.courseMaterials.map(material => [material.id, material]));
    const intentsById = new Map(database.chatIntents.map(intent => [intent.id, intent]));
    const summaries = new Map();
    database.chatLogs.forEach(log => {
      const material = materialsById.get(log.matchedMaterialId);
      const courseId = log.courseId || (material && material.courseId);
      const course = coursesById.get(courseId);
      const student = database.users.find(candidate => candidate.id === log.userId && candidate.role === 'student');
      if (!course || !student || !studentEnrolled(database, student.id, course.id)) return;
      const intent = intentsById.get(log.matchedIntentId);
      const topicTag = (intent && intent.topicTag) || (material && material.topicTag) || 'Unmatched query';
      const key = course.id + '|' + topicTag.toLowerCase();
      if (!summaries.has(key)) summaries.set(key, {
        courseCode: course.courseCode, topicTag, queryCount: 0, fallbackCount: 0, lastAskedAt: log.createdAt
      });
      const summary = summaries.get(key);
      summary.queryCount += 1;
      if (!log.matchedMaterialId) summary.fallbackCount += 1;
      if (new Date(log.createdAt) > new Date(summary.lastAskedAt)) summary.lastAskedAt = log.createdAt;
    });
    const topics = [...summaries.values()]
      .sort((a, b) => b.queryCount - a.queryCount || a.topicTag.localeCompare(b.topicTag))
      .slice(0, 20);
    return sendJson(response, 200, { topics });
  }

  if (request.method === 'GET' && pathname === '/api/quizzes') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const quizzes = database.quizzes.filter(quiz => studentEnrolled(database, user.id, quiz.courseId)).map(quiz => ({
      id: quiz.id, courseId: quiz.courseId, title: quiz.title, courseCode: quiz.courseCode,
      courseTitle: quiz.courseTitle, level: quiz.level || database.taughtCourses.find(course => course.id === quiz.courseId)?.level || '',
      lecturerName: quiz.lecturerName,
      topicTag: quiz.topicTag || '', passThreshold: Number.isInteger(quiz.passThreshold) ? quiz.passThreshold : 70,
      durationMinutes: quiz.durationMinutes, questionCount: quiz.questions.length,
      createdAt: quiz.createdAt
    }));
    return sendJson(response, 200, { quizzes });
  }

  const quizStartPath = pathname.match(/^\/api\/quizzes\/([^/]+)\/start$/);
  if (request.method === 'POST' && quizStartPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const quiz = database.quizzes.find(item => item.id === quizStartPath[1]);
    if (!quiz) return sendJson(response, 404, { error: 'Quiz not found.' });
    if (!studentEnrolled(database, user.id, quiz.courseId)) return sendJson(response, 403, { error: 'Enroll in this course before starting its quiz.' });
    const startedAt = Date.now();
    const attempt = {
      id: crypto.randomUUID(), quizId: quiz.id, studentId: user.id,
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(startedAt + quiz.durationMinutes * 60 * 1000).toISOString()
    };
    database.quizAttempts.unshift(attempt);
    await writeDatabase(database);
    return sendJson(response, 201, {
      attemptId: attempt.id, expiresAt: attempt.expiresAt,
      quiz: {
        id: quiz.id, title: quiz.title, courseCode: quiz.courseCode,
        courseId: quiz.courseId, topicTag: quiz.topicTag || '', passThreshold: Number.isInteger(quiz.passThreshold) ? quiz.passThreshold : 70,
        durationMinutes: quiz.durationMinutes,
        questions: quiz.questions.map(({ q, opts }) => ({ q, opts }))
      }
    });
  }

  const quizPath = pathname.match(/^\/api\/quizzes\/([^/]+)$/);
  if (request.method === 'GET' && quizPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const quiz = database.quizzes.find(item => item.id === quizPath[1]);
    if (!quiz) return sendJson(response, 404, { error: 'Quiz not found.' });
    if (!studentEnrolled(database, user.id, quiz.courseId)) return sendJson(response, 403, { error: 'Enroll in this course before viewing its quiz.' });
    return sendJson(response, 200, {
      quiz: {
        id: quiz.id, title: quiz.title, courseCode: quiz.courseCode,
        durationMinutes: quiz.durationMinutes,
        questions: quiz.questions.map(({ q, opts }) => ({ q, opts }))
      }
    });
  }

  const quizSubmitPath = pathname.match(/^\/api\/quizzes\/([^/]+)\/submit$/);
  if (request.method === 'POST' && quizSubmitPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const quiz = database.quizzes.find(item => item.id === quizSubmitPath[1]);
    if (!quiz) return sendJson(response, 404, { error: 'Quiz not found.' });
    if (!studentEnrolled(database, user.id, quiz.courseId)) return sendJson(response, 403, { error: 'Enroll in this course before submitting its quiz.' });
    const payload = await readBody(request);
    const attempt = database.quizAttempts.find(item => item.id === payload.attemptId && item.quizId === quiz.id && item.studentId === user.id);
    if (!attempt) return sendJson(response, 404, { error: 'Quiz attempt not found.' });
    if (attempt.submittedAt) return sendJson(response, 409, { error: 'This quiz attempt has already been submitted.' });
    if (Date.now() > new Date(attempt.expiresAt).getTime() + 60000) return sendJson(response, 409, { error: 'The time limit has expired.' });
    if (!Array.isArray(payload.answers) || payload.answers.length !== quiz.questions.length || payload.answers.some((answer, index) => answer !== null && (!Number.isInteger(answer) || answer < 0 || answer >= quiz.questions[index].opts.length))) {
      return sendJson(response, 400, { error: 'Answers must contain one valid option or no answer for each question.' });
    }
    const correct = quiz.questions.reduce((total, question, index) => total + (payload.answers[index] === question.ans ? 1 : 0), 0);
    const score = Math.round(correct / quiz.questions.length * 100);
    const topicTag = quiz.topicTag || quiz.title;
    const passThreshold = Number.isInteger(quiz.passThreshold) ? quiz.passThreshold : 70;
    const result = {
      id: crypto.randomUUID(), userId: user.id, courseCode: quiz.courseCode,
      quizId: quiz.id, quizTitle: quiz.title, courseId: quiz.courseId,
      topicTag, passThreshold, answers: payload.answers, score, correct,
      total: quiz.questions.length, date: new Date().toISOString()
    };
    attempt.submittedAt = result.date;
    attempt.score = score;
    database.quizResults.unshift(result);
    const progress = database.progressLogs.find(item =>
      item.userId === user.id && item.courseId === quiz.courseId && item.topicTag === topicTag
    );
    if (progress) {
      progress.attemptCount += 1;
      progress.totalScore += score;
      progress.averageScore = Math.round(progress.totalScore / progress.attemptCount);
      progress.lastScore = score;
      progress.passThreshold = passThreshold;
      progress.masteryLevel = score >= passThreshold ? 'mastered' : 'below_threshold';
      progress.lastUpdated = result.date;
    } else {
      database.progressLogs.unshift({
        id: crypto.randomUUID(), userId: user.id, courseId: quiz.courseId,
        courseCode: quiz.courseCode, topicTag, passThreshold,
        attemptCount: 1, totalScore: score, averageScore: score, lastScore: score,
        masteryLevel: score >= passThreshold ? 'mastered' : 'below_threshold',
        lastUpdated: result.date
      });
    }
    await writeDatabase(database);
    return sendJson(response, 200, {
      result,
      review: quiz.questions.map((question, index) => ({
        q: question.q, opts: question.opts, ans: question.ans,
        selected: payload.answers[index], exp: question.exp
      }))
    });
  }

  if (request.method === 'GET' && pathname === '/api/student/progress') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const progress = database.progressLogs
      .filter(item => item.userId === user.id)
      .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))
      .map(item => {
        const resource = item.masteryLevel === 'below_threshold'
          ? database.courseMaterials.find(material =>
            studentEnrolled(database, user.id, material.courseId) &&
            material.courseId === item.courseId &&
            String(material.topicTag || '').toLowerCase() === item.topicTag.toLowerCase()
          )
          : null;
        if (!resource) return { ...item, recommendation: null };
        const { storageName, ...publicResource } = resource;
        return {
          ...item,
          recommendation: {
            material: {
              ...publicResource,
              ...(resource.resourceType === 'video' ? {} : { downloadUrl: '/api/materials/' + resource.id + '/download' })
            },
            message: 'Review this course material and try another quiz on the topic.'
          }
        };
      });
    return sendJson(response, 200, { progress });
  }

  if (pathname === '/api/student/reading-progress' && request.method === 'GET') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const requestedCourseId = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams.get('courseId');
    if (requestedCourseId && !studentEnrolled(database, user.id, requestedCourseId)) {
      return sendJson(response, 403, { error: 'Enroll in this course before viewing its reading plan.' });
    }
    const readings = database.courseMaterials
      .filter(material => studentEnrolled(database, user.id, material.courseId) &&
        (!requestedCourseId || material.courseId === requestedCourseId))
      .map(material => {
        const { storageName, ...publicMaterial } = material;
        const saved = database.readingProgress.find(item =>
          item.userId === user.id && item.materialId === material.id
        );
        return {
          material: publicMaterial,
          status: saved ? saved.status : 'not_started',
          targetDate: saved ? saved.targetDate : null,
          lastUpdated: saved ? saved.lastUpdated : null
        };
      })
      .sort((a, b) => a.material.title.localeCompare(b.material.title));
    return sendJson(response, 200, { readings });
  }

  if (pathname === '/api/student/reading-progress' && request.method === 'POST') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const payload = await readBody(request);
    const materialId = typeof payload.materialId === 'string' ? payload.materialId : '';
    const status = payload.status;
    const targetDate = payload.targetDate === '' || payload.targetDate === null ? null : payload.targetDate;
    const material = database.courseMaterials.find(item => item.id === materialId);
    if (!material || !studentEnrolled(database, user.id, material.courseId)) {
      return sendJson(response, 404, { error: 'Course material not found for an enrolled course.' });
    }
    if (!['not_started', 'in_progress', 'completed'].includes(status)) {
      return sendJson(response, 400, { error: 'Choose not started, in progress, or completed as the reading status.' });
    }
    if (targetDate !== null) {
      if (typeof targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return sendJson(response, 400, { error: 'Target date must be a valid calendar date.' });
      }
      const parsedTargetDate = new Date(targetDate + 'T00:00:00.000Z');
      if (Number.isNaN(parsedTargetDate.getTime()) || parsedTargetDate.toISOString().slice(0, 10) !== targetDate) {
        return sendJson(response, 400, { error: 'Target date must be a valid calendar date.' });
      }
    }
    let reading = database.readingProgress.find(item =>
      item.userId === user.id && item.materialId === material.id
    );
    if (!reading) {
      reading = { id: crypto.randomUUID(), userId: user.id, materialId: material.id };
      database.readingProgress.unshift(reading);
    }
    reading.courseId = material.courseId;
    reading.topicTag = material.topicTag || '';
    reading.status = status;
    reading.targetDate = targetDate;
    reading.lastUpdated = new Date().toISOString();
    await writeDatabase(database);
    return sendJson(response, 200, { reading });
  }

  if (request.method === 'GET' && pathname === '/api/student/exam-predictions') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const requestedCourseId = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams.get('courseId');
    if (requestedCourseId && !studentEnrolled(database, user.id, requestedCourseId)) {
      return sendJson(response, 403, { error: 'Enroll in this course to view its exam revision guide.' });
    }
    const topics = new Map();
    database.pastQuestions
      .filter(item => studentEnrolled(database, user.id, item.courseId) &&
        (!requestedCourseId || item.courseId === requestedCourseId))
      .forEach(item => {
        const key = item.courseId + '|' + item.topicTag.trim().toLowerCase();
        let topic = topics.get(key);
        if (!topic) {
          topic = {
            courseId: item.courseId,
            courseCode: item.courseCode,
            courseTitle: item.courseTitle,
            topicTag: item.topicTag,
            questions: [],
            years: new Set()
          };
          topics.set(key, topic);
        }
        topic.questions.push({
          id: item.id,
          questionText: item.questionText,
          examYear: item.examYear
        });
        topic.years.add(item.examYear);
      });
    const readings = database.readingProgress.filter(item => item.userId === user.id);
    const recommendations = Array.from(topics.values()).map(topic => {
      const matchingMaterials = database.courseMaterials.filter(material =>
        material.courseId === topic.courseId &&
        String(material.topicTag || '').trim().toLowerCase() === topic.topicTag.trim().toLowerCase()
      );
      const topicRead = matchingMaterials.length > 0 && matchingMaterials.every(material =>
        readings.some(reading => reading.materialId === material.id && reading.status === 'completed')
      );
      const progress = database.progressLogs.find(item =>
        item.userId === user.id &&
        item.courseId === topic.courseId &&
        String(item.topicTag || '').trim().toLowerCase() === topic.topicTag.trim().toLowerCase()
      );
      const belowMastery = Boolean(progress && progress.masteryLevel === 'below_threshold');
      const reasons = [];
      if (!topicRead) reasons.push('Reading for this topic is not marked complete.');
      if (belowMastery) reasons.push('Your latest recorded quiz score is below the mastery target.');
      return {
        courseId: topic.courseId,
        courseCode: topic.courseCode,
        courseTitle: topic.courseTitle,
        topicTag: topic.topicTag,
        questionCount: topic.questions.length,
        years: Array.from(topic.years).sort((a, b) => b - a),
        questions: topic.questions.sort((a, b) => b.examYear - a.examYear),
        priority: reasons.length > 0,
        priorityReasons: reasons,
        latestScore: progress ? progress.lastScore : null,
        passThreshold: progress ? progress.passThreshold : null
      };
    }).sort((a, b) =>
      Number(b.priority) - Number(a.priority) ||
      b.questionCount - a.questionCount ||
      a.courseCode.localeCompare(b.courseCode) ||
      a.topicTag.localeCompare(b.topicTag)
    );
    return sendJson(response, 200, {
      guidance: 'Topics are ranked by recorded past-question frequency and your reading and quiz history. This is revision guidance, not a guaranteed exam forecast.',
      recommendations
    });
  }

  if (request.method === 'GET' && pathname === '/api/student/quiz-results') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const results = database.quizResults
      .filter(item => item.userId === user.id)
      .slice(0, 50)
      .map(({ answers, ...result }) => result);
    return sendJson(response, 200, { results });
  }

  if (request.method === 'POST' && pathname === '/api/student/chat') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const payload = await readBody(request);
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (query.length < 3 || query.length > 500) return sendJson(response, 400, { error: 'Ask a question between 3 and 500 characters.' });
    const requestedCourseId = typeof payload.courseId === 'string' ? payload.courseId : '';
    if (requestedCourseId && !studentEnrolled(database, user.id, requestedCourseId)) {
      return sendJson(response, 403, { error: 'Enroll in this course before searching its resources.' });
    }
    const requestedCode = requestedCourseCode(query);
    const requestedMaterialId = requestedCode
      ? ''
      : (typeof payload.materialId === 'string' ? payload.materialId : '');
    if (requestedMaterialId) {
      const requestedMaterial = database.courseMaterials.find(material => material.id === requestedMaterialId);
      if (!requestedMaterial || !studentEnrolled(database, user.id, requestedMaterial.courseId) ||
          (requestedCourseId && requestedMaterial.courseId !== requestedCourseId)) {
        return sendJson(response, 403, { error: 'That course resource is not available to your account.' });
      }
    }
    const materials = database.courseMaterials.filter(material =>
      studentEnrolled(database, user.id, material.courseId) &&
      (!requestedCourseId || material.courseId === requestedCourseId) &&
      (!requestedMaterialId || material.id === requestedMaterialId) &&
      (!requestedCode || normalizedCourseCode(material.courseCode) === requestedCode)
    );
    const ranked = materials.map(material => ({ material, confidence: topicMatchScore(query, material) }))
      .sort((a, b) =>
        b.confidence - a.confidence ||
        Number(path.extname(b.material.fileName || '').toLowerCase() === '.pdf') -
          Number(path.extname(a.material.fileName || '').toLowerCase() === '.pdf')
      );
    const materialById = new Map(materials.map(material => [material.id, material]));
    const rankedIntents = database.chatIntents
      .filter(intent => materialById.has(intent.linkedMaterialId))
      .map(intent => ({ intent, material: materialById.get(intent.linkedMaterialId), confidence: chatIntentScore(query, intent) }))
      .sort((a, b) => b.confidence - a.confidence);
    const targetedDocumentQuery = Boolean(requestedCode || requestedMaterialId || isSummaryQuery(query) || isDocumentHelpQuery(query));
    const intentMatch = !targetedDocumentQuery && rankedIntents[0] && rankedIntents[0].confidence >= 0.34
      ? rankedIntents[0]
      : null;
    const materialMatch = ranked[0] && (
      ranked[0].confidence >= 0.34 ||
      requestedCode ||
      requestedMaterialId ||
      ((isSummaryQuery(query) || isDocumentHelpQuery(query)) && materials.length === 1)
    ) ? ranked[0] : null;
    const match = targetedDocumentQuery ? materialMatch : intentMatch || materialMatch;
    database.chatLogs.unshift({
      id: crypto.randomUUID(), userId: user.id, query,
      courseId: requestedCourseId || (match ? match.material.courseId : null),
      matchedMaterialId: match ? match.material.id : null,
      matchedIntentId: intentMatch ? intentMatch.intent.id : null,
      confidence: match ? match.confidence : 0,
      createdAt: new Date().toISOString()
    });
    database.chatLogs.length = Math.min(database.chatLogs.length, 1000);
    await writeDatabase(database);
    if (!match) {
      const enrolledCourseIds = new Set(database.courseEnrollments
        .filter(enrollment => enrollment.studentId === user.id)
        .map(enrollment => enrollment.courseId));
      const answer = enrolledCourseIds.size === 0
        ? 'Enroll in a course to search its topic-tagged materials for relevant resources.'
        : materials.length === 0
          ? 'There are no course materials available in your enrolled courses yet. Ask your lecturer to upload a resource tagged with this topic.'
          : 'I could not find a confident match in your enrolled course materials. Try including the course topic or a key term, or ask your lecturer for help.';
      return sendJson(response, 200, {
        answer,
        resource: null, confidence: 0
      });
    }
    const material = match.material;
    let answerText;
    if (!targetedDocumentQuery && intentMatch) {
      answerText = intentMatch.intent.explanation;
    } else if (isDocumentHelpQuery(query)) {
      answerText = `I found "${material.title}" for ${material.courseCode || 'this course'}. Ask your question about the PDF and I’ll look for the answer in its text.`;
    } else if (!material.searchText || !pdfSentences(material.searchText).length) {
      answerText = `I found "${material.title}", but it has no searchable text available. The PDF may be scanned or image-only; open the resource to read it.`;
    } else if (isSummaryQuery(query)) {
      const summary = summarizePdf(material.searchText);
      answerText = summary
        ? `Brief summary of "${material.title}": ${summary}`
        : `I found "${material.title}", but could not extract enough readable text to summarize it.`;
    } else {
      const relevantSentences = rankPdfSentences(query, pdfSentences(material.searchText))
        .filter(sentence => sentence.score >= 0.2)
        .slice(0, 3);
      answerText = relevantSentences.length
        ? `From "${material.title}": ${relevantSentences.map(sentence => `${sentence.text} [p. ${sentence.page}]`).join(' ')}`
        : `I found "${material.title}", but could not find an answer to that question in its extracted text. Try another term or open the PDF to browse it.`;
    }
    return sendJson(response, 200, {
      answer: answerText,
      confidence: Math.round(match.confidence * 100),
      resource: {
        id: material.id, courseId: material.courseId, courseCode: material.courseCode,
        topicTag: material.topicTag || '', title: material.title, fileName: material.fileName,
        resourceType: material.resourceType || 'file',
        ...(material.resourceType === 'video'
          ? { resourceUrl: material.resourceUrl }
          : { downloadUrl: '/api/materials/' + material.id + '/download' }),
        courseUrl: 'course.html?id=' + encodeURIComponent(material.courseId) + '#material-' + encodeURIComponent(material.id)
      }
    });
  }

  if (request.method === 'GET' && pathname === '/api/assignments') {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const assignments = database.assignments
      .filter(assignment => user.role === 'student'
        ? studentEnrolled(database, user.id, assignment.courseId)
        : assignment.lecturerId === user.id)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    if (user.role === 'student') {
      return sendJson(response, 200, { assignments: assignments.map(item => assignmentForStudent(item, database, user.id)) });
    }
    return sendJson(response, 200, {
      assignments: assignments.map(item => ({
        ...item,
        submissionCount: database.assignmentSubmissions.filter(submission => submission.assignmentId === item.id).length
      }))
    });
  }

  if (request.method === 'POST' && pathname === '/api/assignments') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const payload = await readBody(request);
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const courseId = typeof payload.courseId === 'string' ? payload.courseId : '';
    const course = database.taughtCourses.find(item => item.id === courseId && item.lecturerId === user.id);
    const description = typeof payload.description === 'string' ? payload.description.trim() : '';
    const dueAt = typeof payload.dueAt === 'string' ? new Date(payload.dueAt) : null;
    if (title.length < 3 || title.length > 120 || !course || !description || description.length > 5000 || !dueAt || Number.isNaN(dueAt.getTime())) {
      return sendJson(response, 400, { error: 'Choose one of your courses and provide a title, description, and valid due date.' });
    }
    const assignment = {
      id: crypto.randomUUID(),
      lecturerId: user.id,
      courseId: course.id,
      courseTitle: course.courseTitle,
      courseCode: course.courseCode,
      lecturerName: user.name,
      title,
      description,
      dueAt: dueAt.toISOString(),
      createdAt: new Date().toISOString()
    };
    database.assignments.unshift(assignment);
    notifyEnrolledStudents(database, course.id, {
      title: 'New assignment: ' + title,
      body: course.courseCode + ' · Due ' + dueAt.toLocaleString(),
      type: 'assignment',
      referenceId: assignment.id
    });
    await writeDatabase(database);
    return sendJson(response, 201, { assignment });
  }

  const assignmentSubmissionsPath = pathname.match(/^\/api\/assignments\/([^/]+)\/submissions$/);
  if (assignmentSubmissionsPath && request.method === 'POST') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const assignment = database.assignments.find(item => item.id === assignmentSubmissionsPath[1]);
    if (!assignment) return sendJson(response, 404, { error: 'Assignment not found.' });
    if (!studentEnrolled(database, user.id, assignment.courseId)) return sendJson(response, 403, { error: 'Enroll in this course before submitting its assignment.' });
    const payload = await readBody(request);
    const responseText = typeof payload.response === 'string' ? payload.response.trim() : '';
    if (!responseText || responseText.length > 10000) return sendJson(response, 400, { error: 'Your response must be between 1 and 10,000 characters.' });
    const existing = database.assignmentSubmissions.find(item => item.assignmentId === assignment.id && item.studentId === user.id);
    if (existing && existing.grade !== null && existing.grade !== undefined) return sendJson(response, 409, { error: 'This submission has already been graded and can no longer be changed.' });
    const submission = existing || { id: crypto.randomUUID(), assignmentId: assignment.id, studentId: user.id };
    submission.studentName = user.name;
    submission.studentIdentifier = user.identifier;
    submission.response = responseText;
    submission.submittedAt = new Date().toISOString();
    submission.late = Date.now() > new Date(assignment.dueAt).getTime();
    delete submission.grade;
    delete submission.feedback;
    if (!existing) database.assignmentSubmissions.unshift(submission);
    await writeDatabase(database);
    return sendJson(response, 201, { submission });
  }

  if (assignmentSubmissionsPath && request.method === 'GET') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const assignment = database.assignments.find(item => item.id === assignmentSubmissionsPath[1] && item.lecturerId === user.id);
    if (!assignment) return sendJson(response, 404, { error: 'Assignment not found.' });
    return sendJson(response, 200, {
      submissions: database.assignmentSubmissions
        .filter(item => item.assignmentId === assignment.id)
        .map(({ studentId, ...item }) => item)
    });
  }

  const gradeSubmissionPath = pathname.match(/^\/api\/assignments\/([^/]+)\/submissions\/([^/]+)\/grade$/);
  if (gradeSubmissionPath && request.method === 'POST') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'lecturer') return sendJson(response, 401, { error: 'Lecturer authentication required.' });
    const assignment = database.assignments.find(item => item.id === gradeSubmissionPath[1] && item.lecturerId === user.id);
    const submission = database.assignmentSubmissions.find(item => item.id === gradeSubmissionPath[2] && item.assignmentId === gradeSubmissionPath[1]);
    if (!assignment || !submission) return sendJson(response, 404, { error: 'Assignment or submission not found.' });
    const payload = await readBody(request);
    const grade = payload.grade === '' || payload.grade === null || payload.grade === undefined ? NaN : Number(payload.grade);
    const feedback = typeof payload.feedback === 'string' ? payload.feedback.trim() : '';
    if (!Number.isFinite(grade) || grade < 0 || grade > 100 || feedback.length > 3000) {
      return sendJson(response, 400, { error: 'Grade must be between 0 and 100; feedback must be 3,000 characters or fewer.' });
    }
    submission.grade = grade;
    submission.feedback = feedback;
    submission.gradedAt = new Date().toISOString();
    submission.gradedBy = user.name;
    await writeDatabase(database);
    return sendJson(response, 200, { submission });
  }
  if (request.method === 'POST' && (request.url === '/api/auth/register' || request.url === '/api/auth/login')) {
    const payload = await readBody(request);
    const role = payload.role || 'student';
    const isRegistration = request.url === '/api/auth/register';
    if (!['student', 'lecturer', 'admin'].includes(role)) return sendJson(response, 400, { error: 'Choose a valid account role.' });
    if (isRegistration && role !== 'student') {
      return sendJson(response, 403, { error: 'Lecturer and administrator accounts must be created by an administrator.' });
    }
    const error = validateCredentials(payload, role);
    if (error) return sendJson(response, 400, { error });
    if (request.url === '/api/auth/register' && (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim()))) {
      return sendJson(response, 400, { error: 'A valid email address is required.' });
    }

    const identifier = (role === 'student' ? payload.matric : (payload.username || payload.email)).trim().toLowerCase();
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const existingUser = database.users.find(user => user.role === role && (user.identifier === identifier || (email && user.email === email)));

    if (isRegistration) {
      if (!payload.name || payload.name.trim().length < 3) return sendJson(response, 400, { error: 'A full name is required.' });
      if (existingUser) return sendJson(response, 409, { error: 'An account with these details already exists.' });
      const user = {
        id: crypto.randomUUID(),
        identifier,
        email: email || undefined,
        name: payload.name.trim(),
        role,
        dept: role === 'student' ? 'IFT' : undefined,
        level: role === 'student' ? String(payload.level || '') : undefined,
        passwordHash: hashPassword(payload.password),
        createdAt: new Date().toISOString()
      };
      database.users.push(user);
      await writeDatabase(database);
      if (user.email) {
        const loginPath = role === 'lecturer' ? '/lecturer-login.html' : '/index.html';
        const accountIdLabel = role === 'lecturer' ? 'Username' : 'Matriculation number';
        await sendMail({
          to: user.email,
          subject: `Your FUTO IFT ${role} account`,
          text: `Hello ${user.name},\n\nYour FUTO IFT ${role} account has been created.\n${accountIdLabel}: ${user.identifier}\nEmail: ${user.email}\nLogin: ${CLIENT_URL}${loginPath}\n\nFor security, your password is not included in email. Use the password you chose during registration. You can reset it from the login page if needed.\n\nRegards,\nFUTO IFT Portal`
        });
      }
      return sendJson(response, 201, { user: publicUser(user), token: await createSession(user, database, false) });
    }

    const loginUser = role === 'lecturer' && email
      ? (database.users.find(user => user.role === role && user.email === email) || existingUser)
      : existingUser;
    if (!loginUser || loginUser.isActive === false || !verifyPassword(payload.password, loginUser.passwordHash)) {
      return sendJson(response, 401, { error: 'Invalid login credentials.' });
    }
    if (loginUser.passwordResetRequired) {
      return sendJson(response, 403, {
        error: 'A password reset is required for this account. Use Forgot password to receive a reset link.',
        passwordResetRequired: true
      });
    }
    const rememberMe = role === 'lecturer' && payload.rememberMe === true;
    return sendJson(response, 200, { user: publicUser(loginUser), token: await createSession(loginUser, database, rememberMe) });
  }

  if (request.method === 'POST' && request.url === '/api/auth/logout') {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let changed = false;
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const sessionCount = database.sessions.length;
      database.sessions = database.sessions.filter(item => item.tokenHash !== tokenHash);
      const previousCount = database.rememberedSessions.length;
      database.rememberedSessions = database.rememberedSessions.filter(item => item.tokenHash !== tokenHash);
      changed = database.sessions.length !== sessionCount || database.rememberedSessions.length !== previousCount;
    }
    if (changed) await writeDatabase(database);
    return sendJson(response, 200, { message: 'Logged out.' });
  }

  if (request.method === 'GET' && request.url === '/api/auth/me') {
    const user = authenticatedUser(request, database);
    return user ? sendJson(response, 200, { user: publicUser(user) }) : sendJson(response, 401, { error: 'Authentication required.' });
  }

  if (request.method === 'POST' && request.url === '/api/auth/forgot-password') {
    const payload = await readBody(request);
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const user = database.users.find(candidate => ['student', 'lecturer', 'admin'].includes(candidate.role) && candidate.email === email);
    if (user) {
      const reset = createResetToken(user);
      user.resetTokenHash = reset.tokenHash;
      user.resetTokenExpiresAt = reset.expiresAt;
      await writeDatabase(database);
      await sendMail({
        to: user.email,
        subject: 'Reset your FUTO IFT account password',
        text: `Hello ${user.name},\n\nReset your password using this link:\n${CLIENT_URL}/reset-password.html?token=${reset.token}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email.`
      });
    }
    return sendJson(response, 200, { message: 'If that email belongs to a student or lecturer account, a reset link has been sent.' });
  }

  if (request.method === 'POST' && request.url === '/api/auth/reset-password') {
    const payload = await readBody(request);
    const tokenHash = typeof payload.token === 'string' ? crypto.createHash('sha256').update(payload.token).digest('hex') : '';
    const user = database.users.find(candidate => ['student', 'lecturer', 'admin'].includes(candidate.role) && candidate.resetTokenHash === tokenHash && candidate.resetTokenExpiresAt > Date.now());
    if (!user || typeof payload.password !== 'string' || payload.password.length < 6) {
      return sendJson(response, 400, { error: 'This reset link is invalid or expired, or the password is too short.' });
    }
    user.passwordHash = hashPassword(payload.password);
    delete user.resetTokenHash;
    delete user.resetTokenExpiresAt;
    delete user.passwordResetRequired;
    revokeUserSessions(database, user.id);
    await writeDatabase(database);
    return sendJson(response, 200, { message: 'Password reset successfully.' });
  }

  if (request.method === 'POST' && request.url === '/api/quiz/results') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const payload = await readBody(request);
    if (!payload.courseCode || !Number.isFinite(Number(payload.score))) return sendJson(response, 400, { error: 'courseCode and score are required.' });
    const result = { id: crypto.randomUUID(), userId: user.id, courseCode: String(payload.courseCode), score: Number(payload.score), date: new Date().toISOString() };
    database.quizResults.unshift(result);
    await writeDatabase(database);
    return sendJson(response, 201, { result });
  }

  if (request.method === 'GET' && request.url.startsWith('/api/leaderboard')) {
    const limit = Math.min(Math.max(Number(new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams.get('limit') || 10), 1), 100);
    const usersById = new Map(database.users.map(user => [user.id, user]));
    const bestScores = new Map();
    database.quizResults.forEach(result => {
      const key = `${result.userId}|${result.courseCode}`;
      if (!bestScores.has(key) || bestScores.get(key).score < result.score) bestScores.set(key, result);
    });
    const leaderboard = [...bestScores.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(result => ({ ...result, user: publicUser(usersById.get(result.userId) || {}) }));
    return sendJson(response, 200, { leaderboard });
  }

  sendJson(response, 404, { error: 'Route not found.' });
}

async function startServer() {
  if (DATABASE_URL) {
    await initializeSupabaseDatabase();
  } else {
    ensureDatabase();
    if (ENV.NODE_ENV === 'production') {
      console.error('Production backend is using local JSON storage. Configure Supabase before accepting real users.');
    }
  }

  http.createServer((request, response) => {
    responseOrigins.set(response, request.headers.origin || '');
    if (databasePool && request.method !== 'OPTIONS' && request.url.startsWith('/api/')) {
      handleSupabaseRequest(request, response).catch(error => {
        console.error('Supabase request failed:', error.message);
        if (!response.headersSent && !response.writableEnded) {
          sendJson(response, 500, { error: 'The portal could not complete this request.' });
        }
      });
      return;
    }
    handleRequest(request, response).catch(error => {
      console.error('Portal request failed:', error.message);
      if (!response.headersSent && !response.writableEnded) {
        sendJson(response, 500, { error: 'The portal could not complete this request.' });
      }
    });
  }).listen(PORT, () => console.log(`FUTO IFT API listening on http://localhost:${PORT}`));
}

export { handleSupabaseRequest, initializeSupabaseDatabase, startServer };
