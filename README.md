# FairRide - P2P Rideshare Matching

> **Demo project** — all fares are simulated and no payment processing is integrated. See the [Important Disclaimer](#important-disclaimer) before running it.

FairRide is a peer-to-peer rideshare matching app. Riders request a ride and are matched in real time with an online driver — with economics designed to favor both sides of the marketplace:

- **Riders pay 20% less** than a comparable standard rideshare trip
- **Drivers keep 95%** of every fare
- **The platform takes only 5%**

By contrast, traditional rideshare platforms typically commission 25–40%+ of each fare. FairRide demonstrates how a lean matching service could pass those savings back to riders and drivers.

## The Economic Model

Fares are simulated from a baseline "standard rideshare" estimate for the route (deterministic per origin/destination pair):

```
FairFare    = baseline × 0.80   // rider pays 20% less
DriverShare = FairFare × 0.95   // driver keeps 95%
PlatformFee = FairFare × 0.05   // platform keeps 5%
```

| Party | Share | Example — $12.00 baseline trip |
|---|---|---|
| Rider pays | 80% of baseline | $9.60 |
| Driver keeps | 95% of fare | $9.12 |
| Platform fee | 5% of fare | $0.48 |

No payment processor is integrated — the breakdown is calculated and displayed in the UI to demonstrate the model.

## Features

- **Accounts for riders and drivers** — sign up with a name, email, password and role, then log in. Passwords are stored only as bcrypt hashes in PostgreSQL, and every login session and realtime connection carries a signed login token (JWT) that the backend verifies.
- **Real-time WebSocket matching** — riders and drivers connect over Socket.io; a ride request is broadcast to every online driver, and the first driver to accept wins the ride (other drivers' offers are dismissed automatically).
- **Haversine distance calculation** — pickup and dropoff addresses are geocoded via OpenStreetMap (Nominatim), and trip distance is computed with the haversine formula.
- **Simulated live GPS tracking** — the driver's browser streams interpolated route coordinates to the rider every 2 seconds, rendered as a live progress track with the driver's current position.
- **Rider and driver dashboards** — the page opens on a Login / Sign Up screen and, once signed in, shows the dashboard for that account's role: riders get a fare quote and search for drivers; drivers go online and accept ride requests from a modal that names the rider.

## Screenshots

> **Note to maintainer:** these two images are placeholders. Take real screenshots of the rider and driver views, save them as `screenshot-rider.png` and `screenshot-driver.png` in the repository root, then commit and push.

![Rider View](screenshot-rider.png)

![Driver View](screenshot-driver.png)

## Tech Stack

- **Node.js** + **Express** — REST endpoints (`/api/fare`, `/api/register`, `/api/login`, `/api/health`)
- **Socket.io** — real-time ride matching and GPS streaming (every connection must present a valid login token)
- **PostgreSQL** (`pg`) — user accounts; the `users` table is created automatically at startup
- **bcrypt** + **JSON Web Tokens** (`jsonwebtoken`) — password hashing and signed login tokens
- **Vanilla JS/HTML/CSS** — single-file frontend, no framework, no build step

## Project Structure

```
FairRide/
├── index.html          # Single-page frontend (login, rider and driver views)
├── README.md
└── backend/
    ├── server.js       # Express + Socket.io server: accounts, fare engine, matching
    ├── smoke-test.js   # Automated end-to-end test of accounts and the matching flow
    ├── render.yaml     # Render deployment spec (with notes for the manual setup)
    ├── package.json
    ├── .env.example    # PORT, DATABASE_URL and JWT_SECRET
    └── .gitignore
```

## How to Run

Requires **Node.js 18+** and a **PostgreSQL** database you can connect to — either one installed locally or a hosted one (for example the *External Database URL* of a Render database, which also works from a laptop). Python 3 is optional, for serving the frontend.

1. **Configure and start the backend** (from the repository root):

   ```bash
   cd backend
   npm install
   cp .env.example .env    # Windows: copy .env.example .env
   ```

   Edit `backend/.env` and set:

   - `DATABASE_URL` — your PostgreSQL connection string, e.g. `postgres://user:password@host:5432/fairride`
   - `JWT_SECRET` — a long random string used to sign login tokens. Generate one with:

     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```

   Then start the server:

   ```bash
   node server.js
   ```

   The server listens on `http://localhost:3000`, creates the `users` table automatically, and also serves the Socket.io browser client. The port can be overridden with `PORT` in the `.env` file. Without `DATABASE_URL` and `JWT_SECRET` the server still starts and quotes fares, but registration and login answer `503` and realtime connections are refused.

2. **Serve the frontend** (from the repository root):

   ```bash
   python -m http.server 5173
   ```

   Open `http://localhost:5173`. (Opening `index.html` directly in a browser also works.)

3. **Test the matching flow with two browser windows.** A browser profile stays signed in as one account, so use one normal window and one incognito window (or two different browsers):

   - **Window A — Driver:** on the **Sign Up** tab enter a name, email and password, choose **I am a Driver**, click **Create Account**, then click **Go Online**.
   - **Window B — Rider:** sign up the same way as **I am a Rider**, enter a pickup and dropoff (e.g. `350 5th Ave, New York, NY` → `Grand Central Terminal, NY`), click **Get Fair Fare**, then **Find a Driver**.
   - Window A shows a ride-request modal naming the rider → click **Accept Ride**. Both windows switch to **Ride in Progress**: the rider sees the driver's name, the exact 95/5 payout breakdown, and a live GPS progress track fed by the driver's simulated location stream. Either window can click **End Ride** to finish. **Log Out** (top right) signs the window out.

**Automated test:** with the backend running and its database reachable, `cd backend && npm test` registers a driver and a rider, checks login and token validation, then drives both clients through the entire flow — fare quote → driver online → rider request → match → GPS relay → ride completion.

## Deployment

The demo is split into a static frontend (Netlify), a Node backend (Render) and a PostgreSQL database (Render):

1. **Backend:** `backend/render.yaml` describes a free Render web service (root directory `backend`, build `npm install`, start `node server.js`). Create it in the Render dashboard from this GitHub repository — Render adds a random suffix to the URL if the name is already taken, so copy the final URL from the dashboard.
2. **Database:** in the Render dashboard choose **New → PostgreSQL**, pick the same region as the backend, and create it. When both are in the same region, use the database's **Internal URL** from its **Connect** menu; from anywhere else, use the **External URL** (the backend handles both, with or without TLS).
3. **Environment variables:** open the backend web service → **Environment** → add `DATABASE_URL` (the database URL from step 2) and `JWT_SECRET` (a long random string) → save and deploy.
4. **Deploy the code:** push to GitHub. Render redeploys the backend on every push.
5. **Frontend:** drag-and-drop the repository folder into <https://app.netlify.com/drop>, or connect the site to the GitHub repository to deploy on every push.

The frontend connects **directly** to the Render backend in production: the Socket.io client script, the REST API and the WebSocket all go to `https://fairride-backend-4rsc.onrender.com`, with no proxy in between. (The backend accepts cross-origin requests, so any frontend domain works.) It picks the backend origin automatically: `window.FAIRRIDE_BACKEND_URL` if set, `http://localhost:3000` during local development, and the Render URL everywhere else. To use a different backend, change the URL in `index.html`.

On Render's free plan the backend sleeps after 15 minutes without traffic, so the first visit after a quiet period pauses while it wakes up. Render's free PostgreSQL databases expire 30 days after creation — upgrade the database to a paid plan before then to keep the accounts.

## REST API

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/register` | none | Create an account (`name`, `email`, `password`, `role`) and return `{ token, user }` |
| `POST /api/login` | none | Verify `email` and `password` and return `{ token, user }` |
| `GET /api/fare` | none | Fare quote for `pickup` and `dropoff` |
| `GET /api/health` | none | Service status |

Login tokens expire after 7 days. Realtime connections must present one: `io(backendUrl, { auth: { token } })`. A connection without a valid token is refused before any event is handled, and a client whose token is no longer valid is sent back to the login screen.

## Realtime Events

| Event | Direction | Purpose |
|---|---|---|
| `driver_online` | driver → server | Register as an available driver (driver accounts only; the name comes from the account) |
| `rider_request` | rider → server → drivers | Broadcast the ride request (rider name, route and fare breakdown) |
| `accept_ride` | driver → server | Accept the ride — first driver to accept wins |
| `ride_matched` | server → rider & driver | Ride is active; both receive driver name and payout breakdown |
| `location_update` | driver → server → rider | Live driver GPS position and trip progress |
| `ride_complete` | either side → both | End the ride and reset both views |

## Important Disclaimer

> **FairRide is a peer-to-peer matching service. Drivers must maintain their own commercial insurance.**

This project is a **software demonstration**, not an operating transportation service:

- All fares are **simulated**; no payment processor of any kind is integrated.
- Accounts are for demonstration only: there is no email verification, no password reset, and no vetting of drivers or riders (background checks, licence or insurance validation).
- Operating a real transportation network company (TNC) or peer-to-peer rideshare service is subject to **local regulations** — including licensing, permits, background checks, vehicle inspections, and commercial insurance requirements — which vary by city, state, and country. Drivers and operators are solely responsible for compliance with all applicable laws.
- This project is **not affiliated with, endorsed by, or connected to** Uber, Lyft, or any other rideshare company.
- **Do not use this software to operate an unlicensed rideshare service.**
