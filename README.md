# FUTO IFT Portal

## Project layout

- `frontend/pages/` contains the portal pages. Public page URLs such as `/dashboard.html` are kept stable by `frontend/_redirects`.
- `frontend/assets/css/` contains the shared stylesheet.
- `frontend/assets/js/` contains frontend configuration and browser scripts.
- `backend/` contains the active Node API and the staged PHP/MySQL migration.
- `render.yaml` and `backend/Dockerfile` describe the current Node API deployment. The PHP API has not replaced it.
- `start-backend.cmd` starts the local Node API and serves the frontend folders.

## Local development

Run `start-backend.cmd`, then open `http://localhost:3000`. The frontend assets remain available at `/assets/...`; page URLs such as `/index.html` and `/dashboard.html` continue to work.

For the PHP/MySQL migration status and setup notes, see [backend/README.md](backend/README.md).

## Netlify frontend deployment

Deploy only `frontend/` as the Netlify publish directory; do not publish the repository root, which contains backend source and data. Leave the build command empty. The frontend uses the existing Render API URL configured in `frontend/assets/js/api-config.js`. In the Render service settings, set `CLIENT_URL` to the exact Netlify site origin (for example, `https://your-site-name.netlify.app`) so browser requests pass CORS checks and account emails link to the deployed site.
