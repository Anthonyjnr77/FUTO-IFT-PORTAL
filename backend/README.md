# FUTO IFT Backend

## Run locally

```powershell
cd backend
npm install
npm start
```

The API runs on `http://localhost:3000`.

## Production architecture

Deploy the backend to a cloud host and set `FUTO_API_BASE` in the frontend to that backend's public `/api` URL. Do not use the local JSON database for production: use a managed database attached to the backend host so accounts survive redeployments. Put SMTP credentials, `CLIENT_URL`, and database credentials in the host's secret environment settings, never in the frontend or repository.

Frontend pages live in `frontend/pages/`, and shared assets live in `frontend/assets/`. The `frontend/assets/js/api-config.js` setting loads before `auth-utils.js` on the pages.

```html
<script>window.FUTO_API_BASE = 'https://your-api-host.example.com/api';</script>
<script src="/assets/js/auth-utils.js"></script>
```

## Render deployment

The repository includes `render.yaml` and `backend/Dockerfile`. In Render, create a new Blueprint from this repository. Set the secret values requested by the Blueprint, including `CLIENT_URL=https://iftportal.netlify.app`, the Gmail SMTP values, and `MAIL_FROM=FUTO IFT Portal <iftportal@gmail.com>`.

The current JSON file is suitable for local development only. Before production launch, attach a managed database or persistent storage; an ephemeral web-service filesystem can lose account data during redeployments.

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
- `GET /api/lecturer/courses` and `POST /api/lecturer/courses` with a lecturer token
- `GET /api/lecturer/courses/:id/students`, `POST /api/lecturer/courses/:id/students`, and `DELETE /api/lecturer/courses/:id/students/:studentId` with the owning lecturer token
- `GET /api/courses` and `POST /api/courses/:id/enroll` with a student token
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

Assignments and text submissions are shared through the backend and stored in `backend/data/db.json` for local development. Submissions can be updated until graded; late submissions are marked, and grades include optional lecturer feedback. Passwords are hashed with Node's `scrypt`; plaintext passwords are never persisted. For production, migrate these records to a managed persistent database as described above.

Lecturer course schedules, student course enrollments, quizzes, timed quiz attempts, announcements, material metadata, and per-student notifications are stored in the local JSON database. Uploaded course files are stored in `backend/data/uploads` and served only to the owning lecturer or enrolled students; the local upload limit is 4 MB. Students can enroll only in courses matching their registered level. Assignments, quizzes, announcements, and materials are course-scoped. Quiz answer keys are not returned to students before submission; the API scores answers and returns the review afterward. Lecturers can publish assessments only for courses on their own teaching timetable and view private per-quiz rankings and question accuracy. For production, use a durable managed database and object storage rather than an ephemeral application filesystem.

Lecturer-created quizzes require a topic tag and mastery threshold; uploaded course materials require a topic tag as well. Submissions update each student's per-course, per-topic mastery record. The student dashboard uses below-threshold results to recommend matching enrolled-course materials. Administrator-maintained chatbot intents (topic, sample phrases, explanation, linked material) are persisted separately from route logic; the matcher searches intents linked to the student's enrolled resources, retains a resource-tag fallback, and logs match/fallback metadata. Lecturer analytics expose aggregate chatbot topic counts without student query text. Lecturers can share HTTPS video-resource links; large video files should remain in managed video storage rather than the local 4 MB document upload.

Lecturer sessions last 8 hours by default. Selecting Remember me stores the browser token on that device and persists only its SHA-256 hash server-side for up to 30 days. Logout and password reset revoke remembered sessions.

## Administrator accounts

The first administrator is provisioned from backend environment secrets; there is no public administrator or lecturer self-registration. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (minimum 12 characters) before starting the backend. `ADMIN_EMAIL` and `ADMIN_NAME` are optional. On first startup, the backend stores only a salted password hash. Keep the bootstrap credentials in the host's secret settings, not source control. Sign in at `/admin-login.html`, then use the administrator page to create student, lecturer, and additional administrator accounts, change roles, and disable or restore accounts. New users' temporary passwords are entered once and must be shared through a separate secure channel.

## Email delivery

The private `.env` file is loaded automatically and excluded from Git. The local template uses Gmail SMTP. Enable 2-Step Verification on the Gmail account, create a Google App Password, and put that 16-character value in `SMTP_PASS`. Use the Gmail address for `SMTP_USER` and `MAIL_FROM`. Until real values replace the placeholders, local development prints an email preview to the server console instead of sending it.

Never email or store a user's plaintext password. Welcome messages include the account identifier and login link; the PHP API sends one when a student registers. Password-reset messages contain a one-time link that expires after 30 minutes.

## PHP/MySQL migration status

The staged PHP implementation is in `backend/php`. Its MySQL schema is `backend/php/schema.sql`, and Apache routes `/api/*` through `backend/php/public/api/index.php`. The PHP API currently implements authentication and administrator account management, password reset, course enrollment and rosters, announcements, course materials and downloads, notifications, quizzes and timed attempts, progress and recommendations, chatbot matching and analytics, assignments and grading, and the leaderboard. PHPMailer is defined in `backend/php/composer.json`; run `composer install --no-dev` in `backend/php` to install it.

**This is not yet a production replacement for the Node API.** The PHP API and JSON importer have not been runtime-tested because PHP, Composer, and MySQL are not installed in the development environment. The API's HTTP 501 fallback remains for unimplemented routes. Existing Node password hashes use `scrypt` and cannot be checked by PHP's current `password_verify` login path. The chosen migration is to invalidate imported passwords so every existing account must use Forgot password after cutover. Keep `api-config.js`, `render.yaml`, and `backend/Dockerfile` on Node until the importer has been run successfully and PHP/MySQL integration and authorization tests pass.

The JSON import utility is `backend/php/bin/import-json.php`. Back up the source JSON and uploads, install the schema into an empty MySQL database, then run `php bin/import-json.php` from `backend/php`; optional first and second arguments specify the JSON export and uploads directory. Run the import before the PHP API starts provisioning an administrator into that database. It imports account, course, enrollment, notification, announcement, material, quiz, attempt/result, progress, chatbot, assignment, and submission data in one transaction. It does not import sessions. It replaces imported account password hashes with random, unusable hashes; users must request password-reset emails after cutover. The importer requires valid email addresses for imported accounts, rejects duplicate account identifiers or emails before database writes, refuses non-empty target tables, checks missing/oversized material files, and records the export SHA-256 to prevent accidental repeat imports.

To prepare a PHP environment for validation, install Composer dependencies and the schema into a MySQL database. Configure `DB_HOST`, `DB_PORT` (optional), `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `CLIENT_URL`, the SMTP variables from `backend/.env.example`, and the administrator bootstrap settings. Apache must enable `mod_rewrite` and allow the included `.htaccess` file. Do not point the production frontend at this API until the migration gates above are complete.
