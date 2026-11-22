# WA Sender

## Run locally
1. Install Node.js 18+
2. `npm install`
3. Copy `.env.example` to `.env` and edit it
4. `npm start`, then open http://localhost:3000
5. Click **Connect**, scan the QR code, upload your Excel file, write the message, click **Start sending**

## Excel format
Columns: **Business Name**, **Mobile Number**, optional **Rating** (or any extra column; use it in the message as `{column_name}`). See `demo_contacts.xlsx`.

## Deploy on Render
Docker runtime, Starter plan, Disk mounted at `/data`, env vars from `.env.example` (`SESSION_PATH=/data/session`).
Set **Health Check Path** to `/health`.

## Health check & keep-alive
- `GET /health` is public and returns `{"status":"ok", ...}`.
- The server pings itself every 10 minutes when `PUBLIC_URL` / `RENDER_EXTERNAL_URL` is set.
- For extra safety, add a free monitor (UptimeRobot or cron-job.org) that calls `/health` every 5 minutes.

## Safety
Test on your own numbers first. Do not message more than 30-50 new numbers per day to avoid a WhatsApp ban.
