const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch { /* Environment variables may be supplied by the host. */ }
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const RESET_MARKER_FILE = path.join(DATA_DIR, '.reset-complete');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const sessions = new Map();

if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_URL) {
  throw new Error('CLIENT_URL must be configured in production.');
}

const mailTransport = process.env.SMTP_HOST && nodemailer ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

async function sendMail({ to, subject, text }) {
  if (process.env.SMTP_HOST && !nodemailer) throw new Error('Install backend dependencies with npm install before enabling SMTP.');
  if (!mailTransport) {
    console.log(`[email preview] To: ${to}\nSubject: ${subject}\n${text}`);
    return;
  }
  await mailTransport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

function ensureDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
  if (process.env.RESET_DATABASE_ONCE === 'true' && !fs.existsSync(RESET_MARKER_FILE)) {
    writeDatabase({ users: [], quizResults: [] });
    fs.writeFileSync(RESET_MARKER_FILE, new Date().toISOString());
  }
  if (!fs.existsSync(DATA_FILE)) {
    writeDatabase({ users: [], quizResults: [] });
  }
  const database = readDatabase();
  let changed = false;
  if (!Array.isArray(database.assignments)) { database.assignments = []; changed = true; }
  if (!Array.isArray(database.assignmentSubmissions)) { database.assignmentSubmissions = []; changed = true; }
  if (!Array.isArray(database.taughtCourses)) { database.taughtCourses = []; changed = true; }
  if (!Array.isArray(database.quizzes)) { database.quizzes = []; changed = true; }
  if (!Array.isArray(database.quizAttempts)) { database.quizAttempts = []; changed = true; }
  if (!Array.isArray(database.courseEnrollments)) { database.courseEnrollments = []; changed = true; }
  if (!Array.isArray(database.notifications)) { database.notifications = []; changed = true; }
  if (!Array.isArray(database.courseAnnouncements)) { database.courseAnnouncements = []; changed = true; }
  if (!Array.isArray(database.courseMaterials)) { database.courseMaterials = []; changed = true; }
  if (!Array.isArray(database.progressLogs)) { database.progressLogs = []; changed = true; }
  if (!Array.isArray(database.chatLogs)) { database.chatLogs = []; changed = true; }
  if (!Array.isArray(database.chatIntents)) { database.chatIntents = []; changed = true; }
  if (!Array.isArray(database.rememberedSessions)) { database.rememberedSessions = []; changed = true; }
  if (changed) writeDatabase(database);
  ensureBootstrapAdmin(database);
}

function ensureBootstrapAdmin(database) {
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username && !password) return;
  if (username.length < 3 || password.length < 12) {
    throw new Error('Configure both ADMIN_USERNAME (at least 3 characters) and ADMIN_PASSWORD (at least 12 characters) to provision the initial administrator.');
  }
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid email address.');
  const existing = database.users.find(user => user.role === 'admin' && user.identifier === username);
  if (existing) return;
  if (database.users.some(user => user.identifier === username || (email && user.email === email))) {
    throw new Error('The configured administrator username or email is already assigned to another account.');
  }
  database.users.push({
    id: crypto.randomUUID(),
    identifier: username,
    ...(email ? { email } : {}),
    name: process.env.ADMIN_NAME || 'Portal Administrator',
    role: 'admin',
    isActive: true,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  });
  writeDatabase(database);
}

function readDatabase() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    throw new Error('Database could not be read.');
  }
}

function writeDatabase(database) {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2));
  fs.renameSync(temporaryFile, DATA_FILE);
}

function sendJson(response, statusCode, body) {
  const allowedOrigin = process.env.CLIENT_URL || '*';
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  response.end(JSON.stringify(body));
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
  const { passwordHash, resetTokenHash, resetTokenExpiresAt, ...safeUser } = user;
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

function createSession(user, database, rememberMe) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (rememberMe ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000);
  sessions.set(token, { userId: user.id, expiresAt });
  if (rememberMe) {
    database.rememberedSessions = database.rememberedSessions.filter(item => item.expiresAt >= Date.now());
    database.rememberedSessions.push({
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      userId: user.id,
      expiresAt
    });
    writeDatabase(database);
  }
  return token;
}

function authenticatedUser(request, database) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const session = sessions.get(token);
  if (session && session.expiresAt >= Date.now()) {
    const user = database.users.find(candidate => candidate.id === session.userId);
    return user && user.isActive !== false ? user : null;
  }
  if (session) sessions.delete(token);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const remembered = database.rememberedSessions.find(item => item.tokenHash === tokenHash && item.expiresAt >= Date.now());
  if (!remembered) return null;
  sessions.set(token, { userId: remembered.userId, expiresAt: remembered.expiresAt });
  const user = database.users.find(candidate => candidate.id === remembered.userId);
  return user && user.isActive !== false ? user : null;
}

function revokeUserSessions(database, userId) {
  sessions.forEach((session, token) => { if (session.userId === userId) sessions.delete(token); });
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
  const stopWords = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'can', 'could', 'explain', 'find', 'for', 'from', 'help', 'how', 'into', 'please', 'show', 'the', 'this', 'what', 'with']);
  const queryTerms = [...new Set(topicTokens(query).filter(token => token.length > 2 && !stopWords.has(token)))];
  if (!queryTerms.length) return 0;
  const resourceTerms = new Set(topicTokens([material.topicTag, material.title, material.fileName].join(' ')));
  const matchingTerms = queryTerms.filter(token => resourceTerms.has(token));
  return matchingTerms.length / queryTerms.length;
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
  const projectRoot = path.resolve(__dirname, '..');
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
    writeDatabase(database);
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
      writeDatabase(database);
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
    writeDatabase(database);
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
    writeDatabase(database);
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
    writeDatabase(database);
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

  if (request.method === 'GET' && pathname === '/api/courses') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const lecturersById = new Map(database.users.map(candidate => [candidate.id, candidate]));
    const courses = database.taughtCourses
      .filter(course => course.level === String(user.level || ''))
      .map(course => ({
        ...course,
        lecturerName: (lecturersById.get(course.lecturerId) || {}).name || 'Lecturer',
        enrolled: studentEnrolled(database, user.id, course.id)
      }))
      .sort((a, b) => a.courseCode.localeCompare(b.courseCode));
    return sendJson(response, 200, { courses });
  }

  const enrollmentPath = pathname.match(/^\/api\/courses\/([^/]+)\/enroll$/);
  if (request.method === 'POST' && enrollmentPath) {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const course = database.taughtCourses.find(item => item.id === enrollmentPath[1]);
    if (!course || course.level !== String(user.level || '')) return sendJson(response, 404, { error: 'This course is not available for your registered level.' });
    if (!studentEnrolled(database, user.id, course.id)) {
      database.courseEnrollments.push({ studentId: user.id, courseId: course.id, enrolledAt: new Date().toISOString() });
      writeDatabase(database);
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

  const notificationReadPath = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (request.method === 'POST' && notificationReadPath) {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const notification = database.notifications.find(item => item.id === notificationReadPath[1] && item.userId === user.id);
    if (!notification) return sendJson(response, 404, { error: 'Notification not found.' });
    notification.readAt = notification.readAt || new Date().toISOString();
    writeDatabase(database);
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
    const course = {
      id: crypto.randomUUID(), lecturerId: user.id, courseCode, courseTitle, level,
      day, startTime, endTime, room, createdAt: new Date().toISOString()
    };
    database.taughtCourses.unshift(course);
    writeDatabase(database);
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
        writeDatabase(database);
      }
      return sendJson(response, 200, { enrolled: true, student: { id: student.id, name: student.name, matric: student.identifier, level: student.level } });
    }

    if (request.method === 'DELETE' && rosterPath[2]) {
      const studentId = decodeURIComponent(rosterPath[2]);
      const existingCount = database.courseEnrollments.length;
      database.courseEnrollments = database.courseEnrollments.filter(enrollment => !(enrollment.courseId === course.id && enrollment.studentId === studentId));
      if (database.courseEnrollments.length !== existingCount) writeDatabase(database);
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
    writeDatabase(database);
    return sendJson(response, 201, { announcement });
  }

  if (request.method === 'GET' && pathname === '/api/materials') {
    const user = authenticatedUser(request, database);
    if (!user) return sendJson(response, 401, { error: 'Authentication required.' });
    const materials = database.courseMaterials
      .filter(item => user.role === 'lecturer' ? item.lecturerId === user.id : studentEnrolled(database, user.id, item.courseId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(({ storageName, ...item }) => ({
        ...item,
        ...(item.resourceType === 'video' ? {} : { downloadUrl: '/api/materials/' + item.id + '/download' })
      }));
    return sendJson(response, 200, { materials });
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
      storageName = id + extension;
      fs.writeFileSync(path.join(DATA_DIR, 'uploads', storageName), fileBuffer, { flag: 'wx' });
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
    database.courseMaterials.unshift(material);
    notifyEnrolledStudents(database, course.id, {
      title: 'New course material: ' + title,
      body: course.courseCode + ' · ' + title,
      type: 'material',
      referenceId: material.id
    });
    writeDatabase(database);
    const { storageName: storedName, ...publicMaterial } = material;
    return sendJson(response, 201, { material: publicMaterial });
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
    const filePath = path.join(DATA_DIR, 'uploads', material.storageName);
    if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'The stored file is unavailable.' });
    response.writeHead(200, {
      'Content-Type': material.contentType,
      'Content-Length': fs.statSync(filePath).size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`,
      'Cache-Control': 'private, no-store'
    });
    return fs.createReadStream(filePath).pipe(response);
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
    writeDatabase(database);
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
      courseTitle: quiz.courseTitle, lecturerName: quiz.lecturerName,
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
    writeDatabase(database);
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
    writeDatabase(database);
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
    const materials = database.courseMaterials.filter(material =>
      studentEnrolled(database, user.id, material.courseId) &&
      (!requestedCourseId || material.courseId === requestedCourseId)
    );
    const ranked = materials.map(material => ({ material, confidence: topicMatchScore(query, material) }))
      .sort((a, b) => b.confidence - a.confidence);
    const materialById = new Map(materials.map(material => [material.id, material]));
    const rankedIntents = database.chatIntents
      .filter(intent => materialById.has(intent.linkedMaterialId))
      .map(intent => ({ intent, material: materialById.get(intent.linkedMaterialId), confidence: chatIntentScore(query, intent) }))
      .sort((a, b) => b.confidence - a.confidence);
    const intentMatch = rankedIntents[0] && rankedIntents[0].confidence >= 0.34 ? rankedIntents[0] : null;
    const materialMatch = ranked[0] && ranked[0].confidence >= 0.34 ? ranked[0] : null;
    const match = intentMatch || materialMatch;
    database.chatLogs.unshift({
      id: crypto.randomUUID(), userId: user.id, query,
      courseId: requestedCourseId || (match ? match.material.courseId : null),
      matchedMaterialId: match ? match.material.id : null,
      matchedIntentId: intentMatch ? intentMatch.intent.id : null,
      confidence: match ? match.confidence : 0,
      createdAt: new Date().toISOString()
    });
    database.chatLogs.length = Math.min(database.chatLogs.length, 1000);
    writeDatabase(database);
    if (!match) {
      return sendJson(response, 200, {
        answer: 'I could not find a confident match in your enrolled course materials. Try including the course topic or a key term, or ask your lecturer for help.',
        resource: null, confidence: 0
      });
    }
    const material = match.material;
    return sendJson(response, 200, {
      answer: intentMatch ? intentMatch.intent.explanation : 'This course resource looks relevant to your question: ' + material.title + '.',
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
    writeDatabase(database);
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
    writeDatabase(database);
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
    writeDatabase(database);
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
      writeDatabase(database);
      if (user.email) {
        const loginPath = role === 'lecturer' ? '/lecturer-login.html' : '/index.html';
        const accountIdLabel = role === 'lecturer' ? 'Username' : 'Matriculation number';
        await sendMail({
          to: user.email,
          subject: `Your FUTO IFT ${role} account`,
          text: `Hello ${user.name},\n\nYour FUTO IFT ${role} account has been created.\n${accountIdLabel}: ${user.identifier}\nEmail: ${user.email}\nLogin: ${CLIENT_URL}${loginPath}\n\nFor security, your password is not included in email. Use the password you chose during registration. You can reset it from the login page if needed.\n\nRegards,\nFUTO IFT Portal`
        });
      }
      return sendJson(response, 201, { user: publicUser(user), token: createSession(user, database, false) });
    }

    const loginUser = role === 'lecturer' && email
      ? (database.users.find(user => user.role === role && user.email === email) || existingUser)
      : existingUser;
    if (!loginUser || loginUser.isActive === false || !verifyPassword(payload.password, loginUser.passwordHash)) {
      return sendJson(response, 401, { error: 'Invalid login credentials.' });
    }
    const rememberMe = role === 'lecturer' && payload.rememberMe === true;
    return sendJson(response, 200, { user: publicUser(loginUser), token: createSession(loginUser, database, rememberMe) });
  }

  if (request.method === 'POST' && request.url === '/api/auth/logout') {
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    sessions.delete(token);
    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const previousCount = database.rememberedSessions.length;
      database.rememberedSessions = database.rememberedSessions.filter(item => item.tokenHash !== tokenHash);
      if (database.rememberedSessions.length !== previousCount) writeDatabase(database);
    }
    return sendJson(response, 200, { message: 'Logged out.' });
  }

  if (request.method === 'GET' && request.url === '/api/auth/me') {
    const user = authenticatedUser(request, database);
    return user ? sendJson(response, 200, { user: publicUser(user) }) : sendJson(response, 401, { error: 'Authentication required.' });
  }

  if (request.method === 'POST' && request.url === '/api/auth/forgot-password') {
    const payload = await readBody(request);
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const user = database.users.find(candidate => ['student', 'lecturer'].includes(candidate.role) && candidate.email === email);
    if (user) {
      const reset = createResetToken(user);
      user.resetTokenHash = reset.tokenHash;
      user.resetTokenExpiresAt = reset.expiresAt;
      writeDatabase(database);
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
    const user = database.users.find(candidate => ['student', 'lecturer'].includes(candidate.role) && candidate.resetTokenHash === tokenHash && candidate.resetTokenExpiresAt > Date.now());
    if (!user || typeof payload.password !== 'string' || payload.password.length < 6) {
      return sendJson(response, 400, { error: 'This reset link is invalid or expired, or the password is too short.' });
    }
    user.passwordHash = hashPassword(payload.password);
    delete user.resetTokenHash;
    delete user.resetTokenExpiresAt;
    database.rememberedSessions = database.rememberedSessions.filter(item => item.userId !== user.id);
    sessions.forEach((session, token) => { if (session.userId === user.id) sessions.delete(token); });
    writeDatabase(database);
    return sendJson(response, 200, { message: 'Password reset successfully.' });
  }

  if (request.method === 'POST' && request.url === '/api/quiz/results') {
    const user = authenticatedUser(request, database);
    if (!user || user.role !== 'student') return sendJson(response, 401, { error: 'Student authentication required.' });
    const payload = await readBody(request);
    if (!payload.courseCode || !Number.isFinite(Number(payload.score))) return sendJson(response, 400, { error: 'courseCode and score are required.' });
    const result = { id: crypto.randomUUID(), userId: user.id, courseCode: String(payload.courseCode), score: Number(payload.score), date: new Date().toISOString() };
    database.quizResults.unshift(result);
    writeDatabase(database);
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

ensureDatabase();
http.createServer((request, response) => {
  handleRequest(request, response).catch(error => sendJson(response, 500, { error: error.message }));
}).listen(PORT, () => console.log(`FUTO IFT API listening on http://localhost:${PORT}`));
