"use strict";

/**
 * Automated end-to-end check of FairRide: accounts + the matching flow.
 * Usage: node smoke-test.js   (expects the server already running on :3000
 * with DATABASE_URL and JWT_SECRET set; FAIRRIDE_BASE overrides the origin)
 */

const { io } = require("socket.io-client");

const BASE = process.env.FAIRRIDE_BASE || "http://localhost:3000";
const PASSWORD = "correct-horse-battery";
const PICKUP = "350 5th Ave, New York, NY";
const DROPOFF = "Grand Central Terminal, New York, NY";
const stamp = Date.now().toString(36); // unique emails on every run

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for '" + event + "'")),
      15000
    );
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function connect(token) {
  const socket = io(BASE, { transports: ["websocket"], auth: { token } });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) =>
      reject(new Error("Socket with a valid token was refused: " + err.message))
    );
  });
}

function firstRefusal(socket) {
  return new Promise((resolve) => socket.once("connect_error", resolve));
}

async function main() {
  // 1. Register a driver and a rider; each response carries a login token
  const driverAccount = await post("/api/register", {
    name: "Smoke Test Driver",
    email: `smoke-driver-${stamp}@example.com`,
    password: PASSWORD,
    role: "driver"
  });
  const riderAccount = await post("/api/register", {
    name: "Smoke Test Rider",
    email: `smoke-rider-${stamp}@example.com`,
    password: PASSWORD,
    role: "rider"
  });
  for (const account of [driverAccount, riderAccount]) {
    if (account.status !== 201 || !account.data.token || !account.data.user) {
      throw new Error("Register failed: " + JSON.stringify(account));
    }
  }
  console.log("1. Registered driver #" + driverAccount.data.user.id +
    " and rider #" + riderAccount.data.user.id + ", both with tokens");

  // 2. Login checks
  const good = await post("/api/login", {
    email: `smoke-driver-${stamp}@example.com`, password: PASSWORD
  });
  if (good.status !== 200 || good.data.user.name !== "Smoke Test Driver") {
    throw new Error("Login with the right password failed: " + JSON.stringify(good));
  }
  const wrong = await post("/api/login", {
    email: `smoke-driver-${stamp}@example.com`, password: "not-the-password"
  });
  if (wrong.status !== 401) throw new Error("Wrong password was accepted");
  const duplicate = await post("/api/register", {
    name: "Someone Else",
    email: `smoke-driver-${stamp}@example.com`,
    password: PASSWORD,
    role: "rider"
  });
  if (duplicate.status !== 409) throw new Error("Duplicate email was accepted");
  console.log("2. Login OK; wrong password -> 401; duplicate email -> 409");

  // 3. Sockets need the token
  const anonymous = io(BASE, { transports: ["websocket"], reconnection: false });
  const refusal = await firstRefusal(anonymous);
  anonymous.close();
  const forged = io(BASE, {
    transports: ["websocket"], reconnection: false, auth: { token: "not.a.jwt" }
  });
  const forgedRefusal = await firstRefusal(forged);
  forged.close();
  for (const err of [refusal, forgedRefusal]) {
    if (!err || !err.data || err.data.code !== "invalid_token") {
      throw new Error("A socket without a valid token was accepted");
    }
  }
  console.log("3. Sockets without a valid token are refused");

  // 4. Driver connects and goes online (the name comes from the account)
  const driver = await connect(driverAccount.data.token);
  const driverAck = once(driver, "driver_online");
  driver.emit("driver_online", { name: "Ignored Client-Sent Name" });
  await driverAck;
  console.log("4. Driver online");

  // 5. Rider requests a ride -> driver receives the offer
  const rider = await connect(riderAccount.data.token);
  const driverOffer = once(driver, "rider_request");
  rider.emit("rider_request", { pickup: PICKUP, dropoff: DROPOFF, fare: { fairFare: 5.58 } });
  const offer = await driverOffer;
  if (offer.pickup !== PICKUP || offer.dropoff !== DROPOFF || offer.riderName !== "Smoke Test Rider") {
    throw new Error("driver received wrong request payload");
  }
  console.log("5. Driver received rider_request");

  // 6. Driver accepts -> both sides get ride_matched
  const riderMatched = once(rider, "ride_matched");
  const driverMatched = once(driver, "ride_matched");
  driver.emit("accept_ride");
  const [riderRide] = await Promise.all([riderMatched, driverMatched]);
  if (riderRide.driver.name !== "Smoke Test Driver") {
    throw new Error("rider got wrong driver name: " + riderRide.driver.name);
  }
  console.log("6. Ride matched: rider sees driver '" + riderRide.driver.name + "'");

  // 7. Driver GPS streams -> rider receives location_update
  const locPromise = once(rider, "location_update");
  driver.emit("location_update", { location: { lat: 40.7, lng: -73.9 }, progress: 0.3 });
  const loc = await locPromise;
  if (!loc.driverLocation || loc.driverLocation.lat !== 40.7) {
    throw new Error("location_update not relayed to rider");
  }
  console.log("7. location_update relayed to rider");

  // 8. Ride ends -> both sides get ride_complete
  const riderDone = once(rider, "ride_complete");
  const driverDone = once(driver, "ride_complete");
  rider.emit("ride_complete");
  await Promise.all([riderDone, driverDone]);
  console.log("8. ride_complete delivered to both sides");

  // 9. The rider account cannot act as a driver
  let wentOnline = false;
  rider.once("driver_online", () => { wentOnline = true; });
  rider.emit("driver_online");
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (wentOnline) throw new Error("a rider account was allowed to go online as a driver");
  console.log("9. Rider account cannot go online as a driver");

  driver.close();
  rider.close();
  console.log("SMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
