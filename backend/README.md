# FUTO IFT Backend

## Run locally

```powershell
cd backend
npm install
npm start
```

The API runs on `http://localhost:3000`.

## Hosting architecture

The browser frontend is hosted on Vercel. The Supabase Edge Function is the target for the API, while the Node server remains for local development and tests. Supabase Postgres stores portal state and a private Supabase Storage bucket stores course files. `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` are backend-only secrets; never place them in frontend code or commit them.

Frontend pages live in `frontend/pages/`, and shared assets live in `frontend/assets/`. The `frontend/assets/js/api-config.js` setting loads before `auth-utils.js` on the pages.

```html
<script>window.FUTO_API_BASE = 'https://your-api-host.example.com/api';</script>
<script src="/assets/js/auth-utils.js"></script>
```

## Supabase Edge deployment

The production API runs from `backend/supabase/functions/api/`. It adapts the existing API request handler to Supabase Edge Functions and keeps portal state, course files, and transactions in Supabase. The Node server remains available for local development and regression tests; it is not the production runtime.

The department curriculum is synchronized into portal state when the backend initializes. Students see the courses for their registered level and can enroll from My Courses; authenticated users can browse the complete catalog through `GET /api/curriculum`. The API enforces the 100-level language elective rule so a student can enroll in only one of IGB or FRN for each semester. Catalog courses can be enrolled before a lecturer is assigned; when a lecturer adds a matching course code and level to their timetable, the existing catalog course is assigned rather than duplicated, preserving enrollments.

The function reads the project's injected database URL and server key when available. Its adapter passes configuration to the existing handler without mutating `process.env`, which is read-only in Supabase Edge Functions. Configure these Edge Function secrets in the Supabase Dashboard before deploying:

- `CLIENT_URL`: the exact HTTPS origin of the Vercel production site
- `ADDITIONAL_CLIENT_URLS`: optional comma-separated HTTPS origins that should remain allowed for browser requests, such as an older Vercel deployment alias
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: bootstrap administrator credentials, only needed if the portal-state row has not been imported yet
- `ADMIN_EMAIL`: a valid recovery address for the bootstrap administrator
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT=465`, and `SMTP_SECURE=true`: Edge Functions cannot send SMTP on port 587. Use an SMTP provider that supports implicit TLS on port 465. `MAIL_FROM` is optional and defaults to the SMTP username.

Import the local JSON database before initializing an empty portal state if existing accounts and records must be preserved. Accounts without a valid email address were removed from the local source after a private backup; the two remaining lecturer accounts are marked as requiring a password reset during import. Their existing password hashes remain only to verify their identity when signing in; no session is issued until they use the emailed reset link. Do not run the importer against non-empty portal state.

After configuring secrets, deploy the function from the repository root using the installed Supabase CLI:

```powershell
& "$HOME\.supabase\bin\supabase.exe" login
& "$HOME\.supabase\bin\supabase.exe" functions deploy api --project-ref atwcwcvvysygaevkdppi --use-api --no-verify-jwt --workdir "$PWD\backend"
```

`supabase/config.toml` disables the gateway JWT check for this function because the legacy API authenticates its own bearer tokens. Route-level authorization remains in the API handler. Do not expose `SUPABASE_SECRET_KEYS`, the service-role key, or the database URL in frontend code.

The function endpoint and production `FUTO_API_BASE` are `https://atwcwcvvysygaevkdppi.supabase.co/functions/v1/api`. The Edge adapter maps the function-root routes to the legacy `/api/*` routes, so do not append another `/api` to this base URL. Verify login, admin/lecturer/student access, materials, assignments, quizzes, and email recovery from the Vercel production site before removing the old Render service.

### Legacy Node deployment

`render.yaml` describes the old Node API service and is retained during the cutover only. Do not deploy new changes to Render.

Apply `backend/supabase/migrations/20261004000000_portal_state_and_storage.sql` and subsequent migrations before deploying. They create a private bucket and server-only tables with row-level security enabled and client-role access revoked.

The Supabase adapter preserves the current API data shape in a single JSONB state row to make the backend transition compatible with existing routes. Mutating API requests are serialized in PostgreSQL to prevent lost updates, and API responses are sent only after the request transaction commits. This is a migration bridge for a low-traffic pilot, **not a horizontally scalable relational data model**. Normalize the portal entities into Postgres tables and add database-level authorization and migration tests before opening a general-availability or high-concurrency production service.

### Migrating the existing local portal

Back up `backend/data/db.json` and `backend/data/uploads` first. Apply the Supabase migration, configure `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ADMIN_USERNAME` in the ignored local `backend/.env`, then run from `backend/`. The importer permits either an empty portal-state row or the single bootstrap administrator created by the Edge Function; it preserves that administrator and refuses to overwrite any other existing data. The Storage bucket name is fixed as `course-materials` in the migration and API:

```powershell
node scripts/migrate-json-to-supabase.js
```

Optional arguments provide a JSON export path and uploads directory. The importer checks for duplicate account identifiers/emails, copies documents to the private bucket, and writes only summary counts. Existing Node `scrypt` password hashes are retained only until each account completes the forced password reset; never share or print the source JSON. Upload objects may remain orphaned if the database import fails after file uploads, and a rerun safely upserts those same object paths.

Until Supabase is configured and the migration is verified, the Node API falls back to local JSON for development only. Do not treat that mode as production storage.

Run the isolated Node API integration tests with `npm test` from `backend/`. They start a temporary server with a throwaway data directory and verify administrator-created lecturer sign-in and the student/lecturer access boundary without using `backend/data`. Supabase integration tests still require a dedicated test project; never run migration or write tests against live portal data.

## Endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/admin/users`, `POST /api/admin/users`, and `POST /api/admin/users/:id/role|status` with an administrator token
- `GET /api/admin/chat-intents`, `POST /api/admin/chat-intents`, and `POST|DELETE /api/admin/chat-intents/:id` with an administrator token
- `GET /api/auth/me` with `Authorization: Bearer <token>`
- `POST /api/auth/logout` with `Authorization: Bearer <token>`
- `POST /api/quiz/results` with a student token
- `GET /api/leaderboard?limit=10`
- `GET|POST /api/student/reading-progress` (students; POST updates material status and optional target date)
- `GET /api/student/exam-predictions` (students; optionally filter with `?courseId=...`)
- `GET|POST /api/past-questions` and `DELETE /api/past-questions/:id` (lecturers for their courses; administrators for all courses)
- `GET /api/lecturer/courses` and `POST /api/lecturer/courses` with a lecturer token
- `GET /api/lecturer/courses/:id/students`, `POST /api/lecturer/courses/:id/students`, and `DELETE /api/lecturer/courses/:id/students/:studentId` with the owning lecturer token
- `GET /api/courses` and `POST /api/courses/:id/enroll` with a student token
- `GET /api/curriculum` with an authenticated token for the full course catalog
- `GET /api/announcements` with an authenticated token and `POST /api/lecturer/announcements` with a lecturer token
- `GET /api/materials` with an authenticated token, `POST /api/lecturer/materials` with a lecturer token, and `GET /api/materials/:id/download` with enrollment or ownership access
- `GET /api/lecturer/quizzes` and `POST /api/lecturer/quizzes` with a lecturer token
- `GET /api/lecturer/quizzes/:id/results` with the owning lecturer token
- `GET /api/lecturer/topic-performance` with a lecturer token
- `GET /api/lecturer/chat-analytics` with a lecturer token; returns aggregate counts only for the lecturer's courses
- `GET /api/quizzes` with a student token
- `POST /api/quizzes/:id/start` and `POST /api/quizzes/:id/submit` with a student token
- `GET /api/student/progress` and `GET /api/student/quiz-results` with a student token
- `POST /api/student/chat` with a student token; searches enrolled-course materials and returns a relevant resource or a safe fallback
- `GET /api/notifications` and `POST /api/notifications/:id/read` with an authenticated token
- `GET /api/assignments` with a student or lecturer token
- `POST /api/assignments` with a lecturer token
- `POST /api/assignments/:id/submissions` with a student token
- `GET /api/assignments/:id/submissions` with the assignment owner's lecturer token
- `POST /api/assignments/:id/submissions/:submissionId/grade` with the assignment owner's lecturer token

Assignments and text submissions are shared through the backend. In local development they are stored in `backend/data/db.json`; with Supabase configured they are persisted in PostgreSQL. Submissions can be updated until graded; late submissions are marked, and grades include optional lecturer feedback. Passwords are hashed with Node's `scrypt`; plaintext passwords are never persisted.

Lecturer course schedules, student course enrollments, quizzes, timed quiz attempts, announcements, material metadata, and per-student notifications are persisted in Supabase when configured. Uploaded course files are stored in the private bucket and served only after the API verifies lecturer ownership or student enrollment; the local development upload limit is 4 MB. Students can enroll only in courses matching their registered level. Assignments, quizzes, announcements, and materials are course-scoped. Quiz answer keys are not returned to students before submission; the API scores answers and returns the review afterward. Lecturers can publish assessments only for courses on their own teaching timetable and view private per-quiz rankings and question accuracy.

Lecturer-created quizzes require a topic tag and mastery threshold; uploaded course materials require a topic tag as well. Submissions update each student's per-course, per-topic mastery record. The student dashboard summarizes each recorded topic's average and latest scores against its mastery target, prioritizes topics needing review, and recommends matching enrolled-course materials. It also shows that student's reading status and target dates for enrolled-course materials, including overdue items. Administrator-maintained chatbot intents (topic, sample phrases, explanation, linked material) are persisted separately from route logic; the matcher searches intents linked to the student's enrolled resources, retains a resource-tag fallback, and logs match/fallback metadata. Lecturer analytics expose aggregate chatbot topic counts without student query text. Lecturers can share HTTPS video-resource links; large video files should remain in managed video storage rather than the local 4 MB document upload.

Session tokens are stored as SHA-256 hashes with an 8-hour expiry; selecting lecturer Remember me extends expiry to 30 days. Sessions are persisted with portal state so a service restart does not invalidate them. Logout, password reset, and administrator account changes revoke relevant sessions.

## Administrator accounts

The first administrator is provisioned from backend environment secrets; there is no public administrator or lecturer self-registration. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (minimum 12 characters) before starting the backend. `ADMIN_EMAIL` and `ADMIN_NAME` are optional. On first startup, the backend stores only a salted password hash. Keep the bootstrap credentials in the host's secret settings, not source control. Sign in at `/admin-login.html`, then use the administrator page to create student, lecturer, and additional administrator accounts, change roles, and disable or restore accounts. New users' temporary passwords are entered once and must be shared through a separate secure channel.

## Email delivery

The private `.env` file is loaded automatically and excluded from Git. The local template uses Gmail SMTP. Enable 2-Step Verification on the Gmail account, create a Google App Password, and put that 16-character value in `SMTP_PASS`. Use the Gmail address for `SMTP_USER` and `MAIL_FROM`. Until real values replace the placeholders, local development prints an email preview to the server console instead of sending it.

Never email or store a user's plaintext password. Welcome messages include the account identifier and login link; the PHP API sends one when a student registers. Password-reset messages contain a one-time link that expires after 30 minutes.

## Legacy PHP/MySQL prototype

`backend/php` contains an earlier, unverified PHP/MySQL migration attempt. Supabase with the existing Node API is now the selected architecture; do not deploy the PHP API or run its MySQL importer as part of this migration. Keep it out of production until it is removed or separately reviewed and tested.
