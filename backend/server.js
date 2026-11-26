"use strict";

/**
 * FairRide backend — P2P ride-matching MVP.
 *
 *   REST   : GET /api/fare?pickup=&dropoff=  (simulated fair-fare quote)
 *            GET /api/health
 *   Socket : driver_online, rider_request, accept_ride, ride_matched,
 *            location_update, ride_complete, driver_offline
 *
 * Fares are SIMULATED (see calculateFairFare): a baseline "standard
 * rideshare" price, 20% cheaper for riders; drivers keep 95%, platform
 * keeps 5%. No payment processor is integrated — the UI shows the
 * breakdown only, to demonstrate the business model.
 *
 * PRODUCTION NOTES (where real services would plug in):
 *   - calculateFairFare(): replace the baseline formula with a real market
 *     price feed (or your own pricing model).
 *   - rider_request: fares should be recomputed server-side instead of
 *     trusted from the client payload.
 *   - driver_online / location_update: real GPS from the driver's device;
 *     validate and persist to a datastore instead of in-memory Maps.
 *   - Payments: integrate Stripe Connect (or similar) for the 95/5 split.
 *
 * Run from this directory:   node server.js   (listens on :3000)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(cors()); // frontend runs from file:// or localhost:5173

const httpServer = http.createServer(app);
// socket.io also serves its browser client at /socket.io/socket.io.js,
// which the frontend loads instead of a CDN.
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const UPSTREAM_TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ */
/* Fare model                                                          */
/* ------------------------------------------------------------------ */

const RIDER_DISCOUNT = 0.20; // riders pay 20% less than standard rideshare
const DRIVER_SHARE = 0.95;   // drivers keep 95% of the fair fare
const PLATFORM_FEE = 1 - DRIVER_SHARE;

const round2 = (n) => Math.round(n * 100) / 100;

// FNV-1a hash — same route always produces the same simulated fare.
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function haversineMiles(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchJSON(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(address) {
  const url =
    `${NOMINATIM_URL}?q=${encodeURIComponent(address)}&format=json&limit=1`;
  const { ok, status, body } = await fetchJSON(url, {
    headers: { "User-Agent": "FairRide-demo/1.0 (local development)" }
  });
  if (!ok) {
    throw new HttpError(502, `Geocoding service error (HTTP ${status}). Try again shortly.`);
  }
  if (!Array.isArray(body) || body.length === 0) return null;
  return { lat: Number(body[0].lat), lng: Number(body[0].lon) };
}

/**
 * SIMULATED FARE — baseline "standard rideshare" estimate for the route,
 * then the FairRide economics: rider pays 20% less, driver keeps 95%,
 * platform keeps 5%. Deterministic per route.
 */
async function calculateFairFare(pickup, dropoff) {
  const [start, end] = await Promise.all([geocode(pickup), geocode(dropoff)]);
  if (!start) {
    throw new HttpError(422, `Could not locate the pickup address: "${pickup}". Try a more specific address.`);
  }
  if (!end) {
    throw new HttpError(422, `Could not locate the dropoff address: "${dropoff}". Try a more specific address.`);
  }

  const miles = haversineMiles(start, end);
  const seed = hashString(
    pickup.trim().toLowerCase() + "\u2192" + dropoff.trim().toLowerCase()
  );
  const jitter = (seed % 100) / 50; // 0–2 deterministic "market" variance
  const baselineTotal = round2(2.5 + miles * 1.75 + 2.0 + jitter);

  const fairFare = round2(baselineTotal * (1 - RIDER_DISCOUNT));
  const driverShare = round2(fairFare * DRIVER_SHARE);
  const platformFee = round2(fairFare - driverShare);

  return {
    pickup: pickup.trim(),
    dropoff: dropoff.trim(),
    miles: Math.round(miles * 10) / 10,
    baselineTotal,   // what a standard rideshare would cost (simulated)
    fairFare,        // what the rider pays (20% less)
    driverShare,     // what the driver keeps (95%)
    platformFee,     // what FairRide keeps (5%)
    riderSavings: round2(baselineTotal - fairFare),
    currency: "USD",
    start,           // included so the demo can animate a GPS track
    end
  };
}

/* ------------------------------------------------------------------ */
/* REST routes                                                         */
/* ------------------------------------------------------------------ */

app.get("/api/fare", async (req, res) => {
  const pickup = String(req.query.pickup || "").trim();
  const dropoff = String(req.query.dropoff || "").trim();

  if (!pickup || !dropoff) {
    return res
      .status(400)
      .json({ error: "Both 'pickup' and 'dropoff' query parameters are required." });
  }
  if (pickup.toLowerCase() === dropoff.toLowerCase()) {
    return res
      .status(400)
      .json({ error: "Pickup and dropoff can't be the same address." });
  }

  try {
    const fare = await calculateFairFare(pickup, dropoff);
    return res.json(fare);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Unexpected error in /api/fare:", err);
    return res.status(500).json({ error: "Unexpected server error. Check the server console." });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    driversOnline: onlineDrivers.size,
    activeRides: activeRides.size,
    pendingRequests: pendingRequests.size
  });
});

/* ------------------------------------------------------------------ */
/* Realtime matching state (in-memory — demo scale)                    */
/* ------------------------------------------------------------------ */

const onlineDrivers = new Map();    // driverSocketId -> {socketId, name, location, busy}
const pendingRequests = new Map();  // riderSocketId -> request
const activeRides = new Map();      // riderSocketId -> ride

function broadcastDriverCount() {
  io.emit("drivers_online", { count: onlineDrivers.size });
}

function endRide(riderId, ride, reason) {
  activeRides.delete(riderId);
  const driver = onlineDrivers.get(ride.driverSocketId);
  if (driver) driver.busy = false;
  const payload = { riderSocketId: riderId, reason };
  io.to(riderId).emit("ride_complete", payload);
  io.to(ride.driverSocketId).emit("ride_complete", payload);
}

io.on("connection", (socket) => {
  socket.data.role = null;

  /* ---- driver events ---- */

  socket.on("driver_online", (payload = {}) => {
    socket.data.role = "driver";
    onlineDrivers.set(socket.id, {
      socketId: socket.id,
      name: String(payload.name || "Demo Driver").slice(0, 40),
      location: payload.location || null,
      busy: false
    });
    socket.emit("driver_online", { ok: true, driversOnline: onlineDrivers.size });
    broadcastDriverCount();
  });

  socket.on("driver_offline", () => {
    if (socket.data.role !== "driver") return;
    const wasInRide = [...activeRides.entries()]
      .find(([riderId, ride]) => ride.driverSocketId === socket.id);
    onlineDrivers.delete(socket.id);
    broadcastDriverCount();
    if (wasInRide) {
      const [riderId, ride] = wasInRide;
      activeRides.delete(riderId);
      io.to(riderId).emit("driver_disconnected", {
        message: "Your driver went offline. The demo ride has ended."
      });
    }
  });

  // Driver accepts a pending ride; first acceptance wins.
  socket.on("accept_ride", () => {
    if (socket.data.role !== "driver") return;
    const driver = onlineDrivers.get(socket.id);
    if (!driver || driver.busy) return;

    for (const [riderId, request] of pendingRequests) {
      pendingRequests.delete(riderId);
      const ride = {
        riderSocketId: riderId,
        driverSocketId: socket.id,
        driver: { name: driver.name },
        pickup: request.pickup,
        dropoff: request.dropoff,
        fare: request.fare,
        startedAt: Date.now()
      };
      activeRides.set(riderId, ride);
      driver.busy = true;

      io.to(riderId).emit("ride_matched", ride);
      socket.emit("ride_matched", ride);
      // Dismiss the offer for every other idle driver.
      for (const d of onlineDrivers.values()) {
        if (d.socketId !== socket.id && !d.busy) {
          io.to(d.socketId).emit("ride_taken", { riderSocketId: riderId });
        }
      }
      return;
    }
  });

  // Driver GPS -> relayed to that driver's active rider only.
  socket.on("location_update", (payload = {}) => {
    if (socket.data.role !== "driver") return;
    const driver = onlineDrivers.get(socket.id);
    if (driver && payload.location) driver.location = payload.location;
    for (const [riderId, ride] of activeRides) {
      if (ride.driverSocketId === socket.id) {
        io.to(riderId).emit("location_update", {
          driverLocation: payload.location,
          progress: payload.progress,
          at: Date.now()
        });
      }
    }
  });

  /* ---- rider events ---- */

  socket.on("rider_request", (payload = {}) => {
    if (socket.data.role === "driver") return;
    socket.data.role = "rider";

    if (onlineDrivers.size === 0) {
      socket.emit("no_drivers", {
        message: "No drivers are online right now. Ask the driver tab to go online first."
      });
      return;
    }

    // DEMO: fare breakdown arrives from the client (already fetched via
    // /api/fare). PRODUCTION: recompute server-side here.
    const request = {
      riderSocketId: socket.id,
      pickup: String(payload.pickup || "").slice(0, 200),
      dropoff: String(payload.dropoff || "").slice(0, 200),
      fare: payload.fare || null,
      requestedAt: Date.now()
    };
    pendingRequests.set(socket.id, request);

    for (const d of onlineDrivers.values()) {
      if (!d.busy) io.to(d.socketId).emit("rider_request", request);
    }
  });

  /* ---- shared events ---- */

  socket.on("ride_complete", () => {
    for (const [riderId, ride] of activeRides) {
      if (ride.driverSocketId === socket.id || riderId === socket.id) {
        endRide(riderId, ride, "completed");
      }
    }
  });

  socket.on("disconnect", () => {
    pendingRequests.delete(socket.id);

    if (onlineDrivers.has(socket.id)) {
      onlineDrivers.delete(socket.id);
      broadcastDriverCount();
      for (const [riderId, ride] of activeRides) {
        if (ride.driverSocketId === socket.id) {
          activeRides.delete(riderId);
          io.to(riderId).emit("driver_disconnected", {
            message: "Your driver disconnected. The demo ride has ended."
          });
        }
      }
      return;
    }

    for (const [riderId, ride] of activeRides) {
      if (riderId === socket.id) {
        activeRides.delete(riderId);
        const driver = onlineDrivers.get(ride.driverSocketId);
        if (driver) driver.busy = false;
        io.to(ride.driverSocketId).emit("rider_disconnected", {
          message: "Your rider disconnected. The demo ride has ended."
        });
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`FairRide backend listening on http://localhost:${PORT}`);
  console.log("Simulated fares — no payment processor integrated (demo only).");
});
