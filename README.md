# Going — Live Auction Platform

A separate, self-contained PS3 mini-hackathon project. English ascending auctions with live public bid history, authenticated sellers/bidders, and a responsive browser UI. It uses SQLite automatically for zero-configuration local development and MongoDB Atlas when `MONGODB_URI` is configured for durable free hosting.

## Run

Install Node.js 24 or newer, then from this folder:

```powershell
npm install
npm start
```

Open http://localhost:3100. Run `npm test` for domain and HTTP integration tests. `npm run dev` enables server restart on source changes. The application starts empty deliberately: create an account and a listing, then use an incognito browser window with another account to bid. Every registered account can sell and bid, except on its own listings. Use a one-minute auction to demonstrate closure; a last-second bid extends the timer. The countdown anchors server time to the browser's monotonic `performance.now()` clock, so changing the device clock during an auction does not shift it.

The MongoDB integration test is skipped unless `MONGODB_TEST_URI` is set. When enabled, it creates a uniquely named temporary database, tests concurrent bid acceptance and retry idempotency, then drops only that temporary database.

## Evaluation criteria: implementation and demonstration

| Criterion | Implementation / evidence |
| --- | --- |
| 1. Users and scope | Public viewers browse listings and histories. Authenticated users create listings, bid, and inspect their activity. No payments, shipping, identity verification, disputes, proxy, sealed or reverse bidding. |
| 2. Auction rules | First bid >= start price, subsequent bid >= leader + increment. Integer paise avoids floating-point comparison. First committed bid wins equal-price contention. Each bid in the last 15 seconds extends to 15 seconds from acceptance, without limit. Listings start immediately and are immutable. Public prices, bidder display names and history; emails and credentials remain private. |
| 3. Architecture and real time | Browser → same-origin Node HTTP API → MongoDB Atlas in hosting or SQLite WAL locally. Server-Sent Events broadcast full canonical snapshots after mutations and on reconnect. One server process, many browser clients. See `server.js`, `mongo-store.js`, `store.js`, `public/app.js`. |
| 4. Storage and closure | Users, expiring sessions, auctions and embedded append-only bid records are persisted in MongoDB. Server checks overdue auctions every second and on snapshot reads; the atomic bid filter independently rejects bids at/after the deadline. Restart closes overdue records before serving state. Mongo TTL indexes remove expired sessions. |
| 5. Simultaneous bids | MongoDB `findOneAndUpdate` validates the deadline, owner, increment and current leader while appending the bid and changing the winner in one atomic document operation. SQLite uses `BEGIN IMMEDIATE` locally. The HTTP test sends equal bids concurrently and verifies exactly one is accepted. |
| 6. End-to-end flow | Register → sign in → create → second account bids → live history/leader → automatic close → winner/final price → active/won/lost dashboard. Domain and HTTP integration tests exercise the flow. |
| 7. Drops and clock skew | SSE reconnect gets a full snapshot, avoiding missed-event gaps. Heartbeats keep the stream active. Server timestamps calibrate countdowns; client clocks never authorize bids or close auctions. UI pauses bidding when stream connectivity is lost. Visibility changes resync state. |
| 8. Cheating and edits | HttpOnly SameSite sessions, password scrypt hashes with per-user salts, same-origin JSON mutation checks, parameterized SQL, foreign keys, request size/rate limits, escaped rendering, CSP, self-bid prevention, strict money validation, no listing edit/delete route. Client-provided bidder identities are ignored; only the session identity is used. |
| 9. Correct final results | Winner and price update atomically with the bid. Closure freezes the existing leader and price. Auctions with no bids close unsold. A retried successful request with the same ID returns its bid without inserting again; changed payloads with a reused ID are rejected. Tests cover exact deadlines, repeated closure and restart durability. |
| 10. Run, test, understand, deploy | Automated tests, Dockerfile, Atlas migration command, environment template and free Render guide below. Local preview can run immediately. No public deployment is claimed until the owner supplies an Atlas connection string and hosting account. |

## API

`GET /api/state` returns public auctions/bids, server time and the current account. `GET /api/events` streams public state. POST JSON to `/api/register` (name, email, password), `/api/login` (email, password), `/api/logout`, `/api/auctions` (title, description, category, start, increment, duration), `/api/auctions/:id/bids` (amount, request). Monetary API fields are integer paise; duration is minutes. A bid request ID must be 8–100 characters and unique per bidder. Registration does not automatically log in. Successful login sets a 24-hour cookie.

## Free deployment: Render + MongoDB Atlas

1. Create a MongoDB Atlas Free cluster, a database user, and an IP access-list entry that permits the Render service to connect. Copy the Node.js `mongodb+srv://...` connection string. Use a generated database password and URL-encode special characters in it.
2. Push this folder to its own GitHub repository.
3. In Render choose **New → Blueprint**, connect the repository, and apply `render.yaml`. It creates a free Docker web service and prompts for the required secrets. No disk is required. You can also create the same Web Service manually.
4. Add `MONGODB_URI` as a secret environment variable, `MONGODB_DATABASE=going`, and `COOKIE_SECURE=1`. Set the health check path to `/api/state`.
5. Deploy. Copy the assigned `https://...onrender.com` URL, add it as `PUBLIC_ORIGIN` with no trailing slash, and redeploy.

Render's free service may sleep when idle. The first request wakes it; MongoDB keeps the data while the web process is asleep. Run only one application instance because live SSE clients are held in process memory.

## Move current local data to Atlas

The migration refuses to write to a non-empty MongoDB database. In PowerShell:

```powershell
$env:MONGODB_URI = "mongodb+srv://..."
$env:MONGODB_DATABASE = "going"
npm run migrate:mongo
```

This copies password hashes, sessions, auctions and bid history from `data/auction.db`. After checking the Atlas data, start against MongoDB with `npm start`. Keep `.env` and connection strings out of Git; `.env.example` contains only placeholders.

## Paid/self-hosted SQLite deployment

```sh
docker build -t going .
docker volume create going-data
docker run -d --name going -p 3100:3100 -v going-data:/app/data going
```

Without `MONGODB_URI`, the container uses SQLite at `/app/data/auction.db`. Run this single container on a persistent host behind an HTTPS reverse proxy. Set `PUBLIC_ORIGIN=https://your-domain.example` and `COOKIE_SECURE=1`. Configure the proxy to disable SSE buffering and permit long-lived responses. Set `HOST=0.0.0.0` for direct non-Docker network access. `PORT` defaults to 3100; `DB_PATH` optionally changes the database file. Keep the database on local persistent disk, not a network filesystem. Back up using SQLite's online backup mechanism or stop the service and copy the complete data directory. Never commit runtime data.

## Correctness and operating limits

The bid acceptance time is the server time when its transaction validates, not the time a user clicks or a packet starts travelling. Equal bids arriving together are ordered by transaction acquisition; there is no promise about network packet order. A closed auction without bids displays its starting price alongside an explicit unsold result; no sale is implied.

This prototype uses one Node process. Do not horizontally replicate it: SSE clients are held in process memory. For larger deployment, use a shared event bus and more selective event payloads. MongoDB stores each auction and its bid history in one document so leader changes are atomic; this also means one auction cannot exceed MongoDB's document-size limit. Snapshots include complete public history and will grow with usage. The countdown uses a server-calibrated monotonic browser clock, so display timing can differ slightly with latency; acceptance remains server-authoritative. Idempotency is provided per bidder request ID, but the UI does not automatically retry bids after ambiguous network failures: inspect history before bidding again. Rate limits are per direct peer IP; reverse proxy installations should add edge rate limiting. Email ownership is not verified. In-memory rate limits reset on restart. There is no password recovery or moderation interface. These are documented limits, not implemented production capabilities.
