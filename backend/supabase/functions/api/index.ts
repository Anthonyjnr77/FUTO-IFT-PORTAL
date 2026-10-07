import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

const apiUrl = Deno.env.get('SUPABASE_URL') ?? '';
const databaseUrl = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  ?? JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default
  ?? '';
const clientUrl = Deno.env.get('CLIENT_URL') ?? '';
const clientOrigin = new URL(clientUrl);
const additionalClientUrls = (Deno.env.get('ADDITIONAL_CLIENT_URLS') ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedClientOrigins = new Set([clientUrl, ...additionalClientUrls]);

if (!apiUrl || !databaseUrl || !serviceRoleKey) {
  throw new Error('Supabase URL, database URL, and server key must be available to the API function.');
}
if (!clientUrl || clientOrigin.protocol !== 'https:' || clientOrigin.origin !== clientUrl.replace(/\/+$/, '')) {
  throw new Error('CLIENT_URL must be the HTTPS origin of the deployed frontend.');
}
for (const origin of additionalClientUrls) {
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('ADDITIONAL_CLIENT_URLS must contain comma-separated HTTPS origins.');
  }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin.replace(/\/+$/, '')) {
    throw new Error('ADDITIONAL_CLIENT_URLS must contain comma-separated HTTPS origins.');
  }
}
if (!Deno.env.get('SMTP_HOST') || !Deno.env.get('SMTP_USER') || !Deno.env.get('SMTP_PASS')) {
  throw new Error('Configure SMTP_HOST, SMTP_USER, and SMTP_PASS in Supabase Function secrets.');
}
if (Deno.env.get('SMTP_PORT') !== '465' || Deno.env.get('SMTP_SECURE') !== 'true') {
  throw new Error('Supabase Edge Functions require SMTP port 465 with implicit TLS; port 587 is blocked.');
}
const adminUsername = Deno.env.get('ADMIN_USERNAME') ?? '';
const adminPassword = Deno.env.get('ADMIN_PASSWORD') ?? '';
const adminEmail = Deno.env.get('ADMIN_EMAIL') ?? '';
if (adminUsername.trim().length < 3 || adminPassword.length < 12) {
  throw new Error('Configure ADMIN_USERNAME (at least 3 characters) and ADMIN_PASSWORD (at least 12 characters) in Function secrets.');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim())) {
  throw new Error('Configure a valid ADMIN_EMAIL in Function secrets for administrator account recovery.');
}

const backendEnv: Record<string, string> = {
  NODE_ENV: 'production',
  SUPABASE_URL: apiUrl,
  DATABASE_URL: databaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  CLIENT_URL: clientUrl,
  ADDITIONAL_CLIENT_URLS: additionalClientUrls.join(',')
};
for (const name of [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM',
  'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_EMAIL', 'ADMIN_NAME'
]) {
  const value = Deno.env.get(name);
  if (value !== undefined) backendEnv[name] = value;
}
// Supabase Edge Functions do not allow writes to process.env.
Object.assign(globalThis, { __FUTO_PORTAL_ENV__: backendEnv });

const loadedBackend = await import('./server-core.js') as {
  handleSupabaseRequest: (request: unknown, response: unknown) => Promise<void>;
  initializeSupabaseDatabase: () => Promise<void>;
};
const { handleSupabaseRequest, initializeSupabaseDatabase } = loadedBackend;

type LegacyResponse = {
  headersSent: boolean;
  writableEnded: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
  writeHead: (statusCode: number, headers: Record<string, string>) => LegacyResponse;
  end: (body?: string | Uint8Array) => LegacyResponse;
};

await initializeSupabaseDatabase();

Deno.serve(async request => {
  const requestOrigin = request.headers.get('origin') ?? '';
  const origin = allowedClientOrigins.has(requestOrigin) ? requestOrigin : clientUrl;
  if (request.method === 'OPTIONS') {
    if (requestOrigin && !allowedClientOrigins.has(requestOrigin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        Vary: 'Origin'
      }
    });
  }

  const bodyChunks: Uint8Array[] = [];
  let bodyLength = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bodyLength += value.byteLength;
      if (bodyLength > 6_000_000) {
        await reader.cancel();
        return new Response(JSON.stringify({ error: 'Request body exceeds the 6 MB limit.' }), {
          status: 413,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Content-Type': 'application/json; charset=utf-8',
            Vary: 'Origin'
          }
        });
      }
      bodyChunks.push(value);
    }
  }
  const body = Buffer.concat(bodyChunks.map(chunk => Buffer.from(chunk)));
  const chunks = body.length ? [body] : [];
  const requestUrl = new URL(request.url);
  const functionPrefix = '/functions/v1/api';
  const routePath = requestUrl.pathname.startsWith(functionPrefix)
    ? requestUrl.pathname.slice(functionPrefix.length) || '/'
    : requestUrl.pathname;
  const incoming = Object.assign(Readable.from(chunks), {
    method: request.method,
    url: `${routePath}${requestUrl.search}`,
    headers: Object.fromEntries(request.headers.entries())
  });

  const outgoing: LegacyResponse = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(responseBody = '') {
      this.body = responseBody;
      this.writableEnded = true;
      return this;
    }
  };

  await handleSupabaseRequest(incoming, outgoing);
  return new Response(
    typeof outgoing.body === 'string' ? outgoing.body : Buffer.from(outgoing.body),
    { status: outgoing.statusCode, headers: outgoing.headers }
  );
});
