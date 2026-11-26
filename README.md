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

- **Real-time WebSocket matching** — riders and drivers connect over Socket.io; a ride request is broadcast to every online driver, and the first driver to accept wins the ride (other drivers' offers are dismissed automatically).
- **Haversine distance calculation** — pickup and dropoff addresses are geocoded via OpenStreetMap (Nominatim), and trip distance is computed with the haversine formula.
- **Simulated live GPS tracking** — the driver's browser streams interpolated route coordinates to the rider every 2 seconds, rendered as a live progress track with the driver's current position.
- **Rider/Driver UI toggles** — a single page serves both roles: riders get a fare quote and search for drivers; drivers go online and accept ride requests from a modal.

## Screenshots

> **Note to maintainer:** these two images are placeholders. Take real screenshots of the rider and driver views, save them as `screenshot-rider.png` and `screenshot-driver.png` in the repository root, then commit and push.

![Rider View](screenshot-rider.png)

![Driver View](screenshot-driver.png)

## Tech Stack

- **Node.js** + **Express** — REST endpoints (`/api/fare`, `/api/health`) and static serving
- **Socket.io** — real-time ride matching and GPS streaming
- **Vanilla JS/HTML/CSS** — single-file frontend, no framework, no build step

## Project Structure

```
FairRide/
├── index.html          # Single-page frontend (rider + driver views)
├── README.md
└── backend/
    ├── server.js       # Express + Socket.io server and fare engine
    ├── smoke-test.js   # Automated end-to-end test of the matching flow
    ├── package.json
    ├── .env.example    # PORT configuration (optional)
    └── .gitignore
```

## How to Run

Requires **Node.js 18+** (Python 3 is optional, for serving the frontend).

1. **Start the backend** (from the repository root):

   ```bash
   cd backend
   npm install
   node server.js
   ```

   The server listens on `http://localhost:3000` and also serves the Socket.io browser client. The port can be overridden with `PORT` in a `.env` file (see `.env.example`).

2. **Serve the frontend** (from the repository root):

   ```bash
   python -m http.server 5173
   ```

   Open `http://localhost:5173`. (Opening `index.html` directly in a browser also works.)

3. **Test the matching flow with two browser windows** (e.g. one normal window and one incognito):

   - **Window A — Driver:** click **I am a Driver**, enter a display name, and click **Go Online**.
   - **Window B — Rider:** click **I am a Rider**, enter a pickup and dropoff (e.g. `350 5th Ave, New York, NY` → `Grand Central Terminal, NY`), click **Get Fair Fare**, then **Find a Driver**.
   - Window A shows a ride-request modal → click **Accept Ride**. Both windows switch to **Ride in Progress**: the rider sees the driver's name, the exact 95/5 payout breakdown, and a live GPS progress track fed by the driver's simulated location stream. Either window can click **End Ride** to finish.

**Automated test:** with the backend running, `cd backend && npm test` drives two Socket.io clients through the entire flow — fare quote → driver online → rider request → match → GPS relay → ride completion.

## Deployment

The demo is split into a static frontend (Netlify) and a Node backend (Render):

- **Backend:** `backend/render.yaml` defines a free Render web service (root directory `backend`, build `npm install`, start `node server.js`). After deploying, note the service URL, e.g. `https://fairride-backend.onrender.com`.
- **Frontend:** `netlify.toml` and `_redirects` proxy `/api/*` and `/socket.io/*` from the Netlify site to the backend. Update the placeholder backend URL in those files, then drag-and-drop the repository folder into <https://app.netlify.com/drop>.
- **Alternative:** point the frontend directly at the backend by setting `window.FAIRRIDE_BACKEND_URL = "https://your-backend.onrender.com"` in `index.html` before the main script.

The frontend picks its backend origin automatically: `window.FAIRRIDE_BACKEND_URL` if set, `http://localhost:3000` during local development, and same-origin relative URLs in production.

## Realtime Events

| Event | Direction | Purpose |
|---|---|---|
| `driver_online` | driver → server | Register as an available driver |
| `rider_request` | rider → server → drivers | Broadcast the ride request (route + fare breakdown) |
| `accept_ride` | driver → server | Accept the ride — first driver to accept wins |
| `ride_matched` | server → rider & driver | Ride is active; both receive driver name and payout breakdown |
| `location_update` | driver → server → rider | Live driver GPS position and trip progress |
| `ride_complete` | either side → both | End the ride and reset both views |

## Important Disclaimer

> **FairRide is a peer-to-peer matching service. Drivers must maintain their own commercial insurance.**

This project is a **software demonstration**, not an operating transportation service:

- All fares are **simulated**; no payment processor of any kind is integrated.
- Operating a real transportation network company (TNC) or peer-to-peer rideshare service is subject to **local regulations** — including licensing, permits, background checks, vehicle inspections, and commercial insurance requirements — which vary by city, state, and country. Drivers and operators are solely responsible for compliance with all applicable laws.
- This project is **not affiliated with, endorsed by, or connected to** Uber, Lyft, or any other rideshare company.
- **Do not use this software to operate an unlicensed rideshare service.**
