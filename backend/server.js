"use strict";

/**
 * FairRide backend — P2P ride-matching MVP.
 *
 *   REST   : POST /api/register, POST /api/login   (accounts, PostgreSQL)
 *            GET /api/fare?pickup=&dropoff=  (simulated fair-fare quote)
 *            GET /api/health
 *   Socket : every connection must present a valid JWT, see
 *            io(url, { auth: { token } }) below. Events: driver_online,
 *            rider_request, accept_ride, ride_matched, location_update,
 *            ride_complete, driver_offline
 *
 * Environment:
 *   DATABASE_URL  PostgreSQL connection string (needed for accounts)
 *   JWT_SECRET    Secret used to sign login tokens (needed for accounts)
 *   PORT          HTTP port (default 3000)
 *
 * The `users` table is created automatically at startup.
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
const net = require("net");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.use(cors()); // the frontend is served from another origin (localhost in development, Netlify in production)
app.use(express.json({ limit: "32kb" })); // request bodies for /api/register + /api/login

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
/* Accounts: PostgreSQL (pg) + JWT                                     */
/* ------------------------------------------------------------------ */

const JWT_SECRET = process.env.JWT_SECRET || null;
const TOKEN_TTL = "7d";       // how long a login token stays valid
const BCRYPT_ROUNDS = 10;
const ROLES = ["rider", "driver"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 60;
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt uses at most the first 72 bytes

// pg lets sslmode=... inside the connection string override the `ssl`
// option, so those parameters are removed from the URL and TLS is set here.
const TLS_URL_PARAMS = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation"];

const CREATE_USERS_TABLE = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('rider', 'driver'))
  )`;

let pool = null;             // pg Pool; null when DATABASE_URL is missing or unusable
let usersTableReady = false;
let usersTablePromise = null;

/**
 * Asks the database server whether it speaks TLS — the same negotiation
 * libpq uses for sslmode=prefer: send an SSLRequest, read one byte,
 * "S" (yes) or "N" (no). Render's public hostname requires TLS while its
 * internal hostname and a local database may not offer it, so the server
 * is asked rather than guessed. pg has no fallback of its own.
 */
function serverHasTls(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false)); // closed without answering
    socket.once("connect", () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);         // packet length
      request.writeInt32BE(80877103, 4);  // SSLRequest
      socket.write(request);
    });
    socket.once("data", (chunk) => finish(chunk[0] === 0x53)); // "S"
  });
}

/**
 * Opens the connection pool and creates the users table. Never throws:
 * without a usable database the ride-matching API still starts, and
 * /api/register + /api/login answer 503 until the problem is fixed.
 */
async function connectDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn("Accounts: DATABASE_URL is not set — /api/register and /api/login answer 503.");
    return;
  }

  let connectionString = process.env.DATABASE_URL;
  let host = "";
  let port = 5432;
  try {
    const parsed = new URL(connectionString);
    host = parsed.hostname;
    port = Number(parsed.port) || port;
    for (const key of TLS_URL_PARAMS) parsed.searchParams.delete(key);
    connectionString = parsed.toString();
  } catch (err) {
    // Not a parseable URL — hand it to pg, which reports what is wrong.
  }

  const tls = host ? await serverHasTls(host, port) : false;
  try {
    pool = new Pool({
      connectionString,
      ssl: tls ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on("error", (err) => console.error("Idle database client error:", err.message));
    await ensureUsersTable();
    console.log(`Accounts: PostgreSQL connected (${tls ? "TLS" : "no TLS"}) — users table ready.`);
  } catch (err) {
    // An unreachable database is retried on every request (see
    // ensureUsersTable); only an unusable URL leaves the server without a pool.
    console.error("Accounts: could not set up PostgreSQL —", err.message);
    console.error("  /api/register and /api/login answer 503 until the database is reachable.");
  }

  if (!JWT_SECRET) {
    console.warn("Accounts: JWT_SECRET is not set — logins are refused.");
  }
}

/** Creates the users table if it does not exist yet. Safe to call often. */
function ensureUsersTable() {
  if (usersTableReady) return Promise.resolve();
  if (!usersTablePromise) {
    usersTablePromise = pool
      .query(CREATE_USERS_TABLE)
      .then(() => { usersTableReady = true; })
      .finally(() => { usersTablePromise = null; });
  }
  return usersTablePromise;
}

/** Throws 503 unless this server can create and verify accounts. */
function requireAccounts() {
  const missing = [!pool && "DATABASE_URL", !JWT_SECRET && "JWT_SECRET"].filter(Boolean);
  if (missing.length) {
    throw new HttpError(503,
      "Accounts aren't configured on this server: set " + missing.join(" and ") + ".");
  }
}

/** Login token for a user row ({ id, name, role }). jwt.sign() needs `sub` as a string. */
function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/** Validates the body of /api/register: name, email, password, role. */
function readProfile(body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Send name, email, password and role as JSON.");
  }
  const name = String(body.name == null ? "" : body.name).trim().replace(/\s+/g, " ");
  const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
  const password = String(body.password == null ? "" : body.password);
  const role = String(body.role == null ? "" : body.role).trim().toLowerCase();
  if (!name || name.length > NAME_MAX) {
    throw new HttpError(400, `Enter your name (1 to ${NAME_MAX} characters).`);
  }
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (password.length < PASSWORD_MIN) {
    throw new HttpError(400, `Password must be at least ${PASSWORD_MIN} characters.`);
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    throw new HttpError(400, `Password is too long (${PASSWORD_MAX_BYTES} bytes maximum).`);
  }
  if (!ROLES.includes(role)) {
    throw new HttpError(400, "Role must be either rider or driver.");
  }
  return { name, email, password, role };
}

/** Validates the body of /api/login: email, password. */
function readLogin(body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Send email and password as JSON.");
  }
  const email = String(body.email == null ? "" : body.email).trim().toLowerCase();
  const password = String(body.password == null ? "" : body.password);
  if (!EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (!password) {
    throw new HttpError(400, "Enter your password.");
  }
  return { email, password };
}

/** Database errors carry a SQLSTATE or system code and mean "try later" (503). */
function sendAccountError(res, route, err) {
  console.error(`Account route ${route} failed:`, err.message);
  if (typeof err.code !== "string") {
    return res.status(500).json({ error: "Unexpected server error. Check the server console." });
  }
  return res.status(503).json({
    error: "The account database is unavailable right now. Please try again shortly."
  });
}

/* ------------------------------------------------------------------ */
/* REST routes                                                         */
/* ------------------------------------------------------------------ */

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, role } = readProfile(req.body);
    requireAccounts();
    await ensureUsersTable();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) " +
      "RETURNING id, name, email, role",
      [name, email, passwordHash, role]
    );
    const user = rows[0];
    return res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.code === "23505") { // unique_violation: email already registered
      return res.status(409).json({
        error: "An account with that email already exists. Try logging in."
      });
    }
    return sendAccountError(res, "/api/register", err);
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = readLogin(req.body);
    requireAccounts();
    await ensureUsersTable();
    const { rows } = await pool.query(
      "SELECT id, name, email, role, password_hash FROM users WHERE email = $1",
      [email]
    );
    const user = rows[0];
    const passwordMatches = user && await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    delete user.password_hash;
    return res.json({ token: signToken(user), user });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    return sendAccountError(res, "/api/login", err);
  }
});

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
    accounts: Boolean(pool && JWT_SECRET),
    driversOnline: onlineDrivers.size,
    activeRides: activeRides.size,
    pendingRequests: pendingRequests.size
  });
});

// Body-parser rejections (malformed or oversized JSON) and anything
// unexpected leave as JSON too, matching the { error } shape of the routes.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.status === 413) {
    return res.status(413).json({ error: "Request body is too large." });
  }
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: "Request body must be valid JSON." });
  }
  console.error("Unexpected server error:", err);
  return res.status(500).json({ error: "Unexpected server error. Check the server console." });
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

/**
 * Every socket must present a valid login token:
 *   io(url, { auth: { token } })
 * The decoded account ({ id, name, role }) is attached to socket.data.user;
 * connections without a valid token are refused.
 */
io.use((socket, next) => {
  const refuse = (reason, message) => {
    const err = new Error(message);
    err.data = { code: "invalid_token", reason }; // reaches the client on connect_error
    next(err);
  };
  if (!JWT_SECRET) {
    const err = new Error("Accounts aren't configured on this server (JWT_SECRET is missing).");
    err.data = { code: "auth_unavailable" };
    return next(err);
  }
  let payload;
  try {
    payload = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
  } catch (err) {
    return refuse(err && err.name === "TokenExpiredError" ? "expired" : "invalid",
      "A valid login token is required to connect.");
  }
  if (typeof payload.sub !== "string" || typeof payload.name !== "string" || !ROLES.includes(payload.role)) {
    return refuse("invalid", "A valid login token is required to connect.");
  }
  socket.data.user = { id: Number(payload.sub), name: payload.name, role: payload.role };
  socket.data.role = payload.role;
  next();
});

io.on("connection", (socket) => {
  const user = socket.data.user; // set by the auth middleware above

  /* ---- driver events ---- */

  socket.on("driver_online", (payload = {}) => {
    if (user.role !== "driver") return; // the role comes from the account
    onlineDrivers.set(socket.id, {
      socketId: socket.id,
      userId: user.id,
      name: user.name,
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
        riderName: request.riderName,
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
    if (user.role !== "rider") return; // the role comes from the account

    if (onlineDrivers.size === 0) {
      socket.emit("no_drivers", {
        message: "No drivers are online right now. Try again in a moment."
      });
      return;
    }

    // DEMO: fare breakdown arrives from the client (already fetched via
    // /api/fare). PRODUCTION: recompute server-side here.
    const request = {
      riderSocketId: socket.id,
      riderName: user.name,
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

// The HTTP server starts right away and the database is connected alongside
// it (see connectDatabase), so a slow or missing database never blocks startup.
connectDatabase();

httpServer.listen(PORT, () => {
  console.log(`FairRide backend listening on http://localhost:${PORT}`);
  console.log("Simulated fares — no payment processor integrated (demo only).");
});
