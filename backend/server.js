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
  if (!fs.existsSync(DATA_FILE)) {
    writeDatabase({ users: [], quizResults: [] });
  }
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
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
  const { passwordHash, ...safeUser } = user;
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

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  return token;
}

function authenticatedUser(request, database) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  return database.users.find(user => user.id === session.userId) || null;
}

function routeKey(request) {
  return `${request.method} ${new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname}`;
}

function serveClientFile(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const filePath = path.resolve(__dirname, '..', relativePath);
  const workspaceRoot = path.resolve(__dirname, '..');
  if (!filePath.startsWith(workspaceRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  response.end(fs.readFileSync(filePath));
  return true;
}

async function handleRequest(request, response) {
  if (request.method === 'OPTIONS') return sendJson(response, 204, {});
  if (request.method === 'GET' && !request.url.startsWith('/api/') && serveClientFile(request, response)) return;
  const database = readDatabase();

  if (routeKey(request) === 'GET /api/health') {
    return sendJson(response, 200, { status: 'ok', service: 'futo-ift-api' });
  }

  if (request.method === 'POST' && (request.url === '/api/auth/register' || request.url === '/api/auth/login')) {
    const payload = await readBody(request);
    const role = payload.role === 'lecturer' ? 'lecturer' : 'student';
    const error = validateCredentials(payload, role);
    if (error) return sendJson(response, 400, { error });
    if (request.url === '/api/auth/register' && (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email.trim()))) {
      return sendJson(response, 400, { error: 'A valid email address is required.' });
    }

    const identifier = (role === 'student' ? payload.matric : (payload.username || payload.email)).trim().toLowerCase();
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const existingUser = database.users.find(user => user.role === role && (user.identifier === identifier || (email && user.email === email)));

    if (request.url === '/api/auth/register') {
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
      return sendJson(response, 201, { user: publicUser(user), token: createSession(user) });
    }

    const loginUser = role === 'lecturer' && email
      ? (database.users.find(user => user.role === role && user.email === email) || existingUser)
      : existingUser;
    if (!loginUser || !verifyPassword(payload.password, loginUser.passwordHash)) {
      return sendJson(response, 401, { error: 'Invalid login credentials.' });
    }
    return sendJson(response, 200, { user: publicUser(loginUser), token: createSession(loginUser) });
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
