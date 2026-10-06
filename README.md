# LearnIT

LearnIT is the FUTO Department of Information Technology learning platform.

## Project layout

- `frontend/pages/` contains the portal pages. Public page URLs such as `/dashboard.html` are kept stable by `frontend/_redirects`.
- `frontend/assets/css/` contains the shared stylesheet.
- `frontend/assets/js/` contains frontend configuration and browser scripts.
- `backend/` contains the Node API, local development launcher, and Supabase integration. An unverified PHP/MySQL prototype is retained as legacy code only.
- `backend/supabase/functions/api/` is the production API target on Supabase Edge Functions. `backend/server.js` remains for local development and regression tests; it is not the intended production host. The PHP API has not replaced it.
- `start-backend.cmd` starts the local Node API and serves the frontend folders.

## Local development

Run `start-backend.cmd`, then open `http://localhost:3000`. The frontend assets remain available at `/assets/...`; page URLs such as `/index.html` and `/dashboard.html` continue to work.

Students can also record reading status and target dates for course materials, and review topic-ranked past examination questions from their enrolled courses. Lecturers and administrators maintain the past-question bank in the staff portal.

For Supabase setup, data migration, and production limitations, see [backend/README.md](backend/README.md).

## Vercel frontend deployment

Import this repository into Vercel and set the project root directory to `frontend/`. The site is static: use the Other framework preset and leave the build command and output directory unset. `frontend/vercel.json` preserves the existing public page URLs while serving HTML from `pages/`; static files under `assets/` remain at their current paths. Do not deploy the repository root, which contains backend source and data.

The frontend continues to use the Supabase Edge Function configured in `frontend/assets/js/api-config.js`; moving the frontend host does not move the backend. Configure `CLIENT_URL` in Supabase Function secrets to the Vercel production origin and any custom domain origin before relying on browser API requests. Keep the Netlify site available until the Vercel deployment, login/recovery flows, and custom domain (if used) have been verified. See [backend/README.md](backend/README.md) for backend deployment and secret configuration.
