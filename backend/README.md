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

The frontend supports this deployment setting before `auth-utils.js` loads:

```html
<script>window.FUTO_API_BASE = 'https://your-api-host.example.com/api';</script>
<script src="auth-utils.js"></script>
```

## Render deployment

The repository includes `render.yaml` and `backend/Dockerfile`. In Render, create a new Blueprint from this repository. Set the secret values requested by the Blueprint, including `CLIENT_URL=https://iftportal.netlify.app`, the Gmail SMTP values, and `MAIL_FROM=FUTO IFT Portal <iftportal@gmail.com>`.

The current JSON file is suitable for local development only. Before production launch, attach a managed database or persistent storage; an ephemeral web-service filesystem can lose account data during redeployments.

## Endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me` with `Authorization: Bearer <token>`
- `POST /api/quiz/results` with a student token
- `GET /api/leaderboard?limit=10`

Data is stored in `backend/data/db.json` for local development. Passwords are hashed with Node's `scrypt`; plaintext passwords are never persisted.

## Email delivery

The private `.env` file is loaded automatically and excluded from Git. The local template uses Gmail SMTP. Enable 2-Step Verification on the Gmail account, create a Google App Password, and put that 16-character value in `SMTP_PASS`. Use the Gmail address for `SMTP_USER` and `MAIL_FROM`. Until real values replace the placeholders, local development prints an email preview to the server console instead of sending it.

Never email or store a user's plaintext password. Welcome messages include the lecturer username and login link; password-reset messages contain a one-time link that expires after 30 minutes.
