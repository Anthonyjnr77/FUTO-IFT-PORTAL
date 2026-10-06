const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const backendRoot = path.resolve(__dirname, '..');
const jsonPath = path.resolve(process.argv[2] || path.join(backendRoot, 'data', 'db.json'));
const uploadsPath = path.resolve(process.argv[3] || path.join(backendRoot, 'data', 'uploads'));
const databaseUrl = process.env.DATABASE_URL || '';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const bucket = 'course-materials';
const mimeTypes = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain'
};

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function dataHasRows(state) {
  return Object.values(state).some(value => Array.isArray(value) && value.length > 0);
}

function existingBootstrapAdmin(state) {
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const users = Array.isArray(state?.users) ? state.users : [];
  const admin = users.length === 1 && users[0].role === 'admin' &&
    typeof users[0].identifier === 'string' &&
    users[0].identifier.trim().toLowerCase() === username
    ? users[0]
    : null;
  if (!admin || Object.entries(state).some(([key, value]) =>
    key !== 'users' && Array.isArray(value) && value.length > 0
  )) return null;
  return admin;
}

function encodeObjectPath(objectPath) {
  return objectPath.split('/').map(encodeURIComponent).join('/');
}

async function main() {
  if (!databaseUrl || !supabaseUrl || !serviceRoleKey) {
    throw new Error('Configure DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY before migration.');
  }
  if (!(process.env.ADMIN_USERNAME || '').trim()) {
    throw new Error('Configure ADMIN_USERNAME to safely preserve the bootstrap administrator during migration.');
  }
  if (!fs.existsSync(jsonPath) || !fs.statSync(jsonPath).isFile() ||
      !fs.existsSync(uploadsPath) || !fs.statSync(uploadsPath).isDirectory()) {
    throw new Error('JSON export or uploads directory is missing. Provide valid source paths.');
  }
  const uploadsRoot = fs.realpathSync(uploadsPath);
  const parsedUrl = new URL(supabaseUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL without embedded credentials.');
  }

  const source = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!source || typeof source !== 'object' || !Array.isArray(source.users)) {
    throw new Error('The JSON export does not contain a valid users list.');
  }
  source.users = source.users.map(user => ({ ...user, passwordResetRequired: true }));
  const identifiers = new Set();
  const emails = new Set();
  for (const user of source.users) {
    if (!user || typeof user.identifier !== 'string' || !user.identifier.trim()) {
      throw new Error('An imported account has an invalid identifier.');
    }
    const identifier = user.identifier.trim().toLowerCase();
    if (identifiers.has(identifier)) throw new Error('Duplicate account identifiers must be resolved before migration.');
    identifiers.add(identifier);
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Each account must have a valid email address for password resets.');
    }
    if (emails.has(email)) throw new Error('Duplicate account email addresses must be resolved before migration.');
    emails.add(email);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000
  });
  try {
    const initialState = await pool.query('SELECT state FROM public.portal_state WHERE id = 1');
    if (initialState.rowCount && dataHasRows(initialState.rows[0].state) &&
        !existingBootstrapAdmin(initialState.rows[0].state)) {
      throw new Error('Supabase already contains portal data. Migration refused to avoid overwriting it.');
    }

    const materials = Array.isArray(source.courseMaterials) ? source.courseMaterials : [];
    let uploadedFiles = 0;
    for (const material of materials) {
      if (!material || material.resourceType === 'video') continue;
      const storageName = material.storageName;
      if (typeof storageName !== 'string' ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.(pdf|doc|docx|txt)$/i.test(storageName)) {
        throw new Error('A course material has an invalid stored filename.');
      }
      const candidatePath = path.join(uploadsRoot, storageName);
      if (!fs.existsSync(candidatePath)) {
        throw new Error('A referenced course-material upload is missing or invalid.');
      }
      const filePath = fs.realpathSync(candidatePath);
      if (!filePath.startsWith(`${uploadsRoot}${path.sep}`) || !fs.statSync(filePath).isFile()) {
        throw new Error('A referenced course-material upload is missing or invalid.');
      }
      const extension = path.extname(storageName).toLowerCase();
      const contents = fs.readFileSync(filePath);
      if (!contents.length || contents.length > 4 * 1024 * 1024) {
        throw new Error('A course-material upload is empty or exceeds the 4 MB limit.');
      }
      const response = await fetch(
        `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeObjectPath(storageName)}`,
        {
          method: 'POST',
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': mimeTypes[extension],
            'x-upsert': 'true'
          },
          body: contents
        }
      );
      if (!response.ok) {
        throw new Error(`A course-material upload failed with status ${response.status}.`);
      }
      uploadedFiles++;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731942816)');
      const locked = await client.query('SELECT state FROM public.portal_state WHERE id = 1 FOR UPDATE');
      const currentState = locked.rowCount ? locked.rows[0].state : null;
      const bootstrapAdmin = currentState ? existingBootstrapAdmin(currentState) : null;
      if (currentState && dataHasRows(currentState) && !bootstrapAdmin) {
        throw new Error('Supabase already contains portal data. Migration refused to avoid overwriting it.');
      }
      const importedState = bootstrapAdmin
        ? { ...source, users: [...source.users, bootstrapAdmin] }
        : source;
      await client.query(
        `INSERT INTO public.portal_state (id, state, updated_at)
         VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(importedState)]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log(`Migration completed: ${source.users.length} accounts, ${materials.length} materials, ${uploadedFiles} files.`);
    console.log('Existing Node scrypt password hashes were preserved; never display or share the source JSON export.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  fail(error.message);
});
