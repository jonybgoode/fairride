"use strict";

/**
 * Automated end-to-end check of the FairRide matching flow.
 * Usage: node smoke-test.js   (expects the server already running on :3000)
 */

const { io } = require("socket.io-client");

const BASE = "http://localhost:3000";
const PICKUP = "350 5th Ave, New York, NY";
const DROPOFF = "Grand Central Terminal, New York, NY";

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

async function main() {
  // 1. REST fare quote
  const res = await fetch(
    BASE + "/api/fare?pickup=" + encodeURIComponent(PICKUP) +
      "&dropoff=" + encodeURIComponent(DROPOFF)
  );
  const fare = await res.json();
  if (!res.ok) throw new Error("Fare API failed: " + JSON.stringify(fare));
  for (const key of ["baselineTotal", "fairFare", "driverShare", "platformFee"]) {
    if (typeof fare[key] !== "number") throw new Error("fare response missing " + key);
  }
  if (Math.abs(fare.driverShare + fare.platformFee - fare.fairFare) > 0.011) {
    throw new Error(
      "95/5 split does not add up: " + fare.driverShare + " + " +
      fare.platformFee + " vs " + fare.fairFare
    );
  }
  console.log("1. Fare OK: rider pays $" + fare.fairFare.toFixed(2) +
    " | driver $" + fare.driverShare.toFixed(2) +
    " | platform $" + fare.platformFee.toFixed(2) +
    " | savings $" + fare.riderSavings.toFixed(2));

  // 2. Driver connects and goes online
  const driver = io(BASE, { transports: ["websocket"] });
  const driverAck = once(driver, "driver_online");
  driver.emit("driver_online", { name: "Smoke Test Driver" });
  await driverAck;
  console.log("2. Driver online");

  // 3. Rider requests a ride -> driver receives the offer
  const rider = io(BASE, { transports: ["websocket"] });
  await new Promise((resolve) => rider.on("connect", resolve));
  const driverOffer = once(driver, "rider_request");
  rider.emit("rider_request", { pickup: PICKUP, dropoff: DROPOFF, fare });
  const offer = await driverOffer;
  if (offer.pickup !== PICKUP || offer.dropoff !== DROPOFF) {
    throw new Error("driver received wrong request payload");
  }
  console.log("3. Driver received rider_request");

  // 4. Driver accepts -> both sides get ride_matched
  const riderMatched = once(rider, "ride_matched");
  const driverMatched = once(driver, "ride_matched");
  driver.emit("accept_ride");
  const [riderRide] = await Promise.all([riderMatched, driverMatched]);
  if (riderRide.driver.name !== "Smoke Test Driver") {
    throw new Error("rider got wrong driver name: " + riderRide.driver.name);
  }
  console.log("4. Ride matched: rider sees driver '" + riderRide.driver.name + "'");

  // 5. Driver GPS streams -> rider receives location_update
  const locPromise = once(rider, "location_update");
  driver.emit("location_update", { location: { lat: 40.7, lng: -73.9 }, progress: 0.3 });
  const loc = await locPromise;
  if (!loc.driverLocation || loc.driverLocation.lat !== 40.7) {
    throw new Error("location_update not relayed to rider");
  }
  console.log("5. location_update relayed to rider");

  // 6. Ride ends -> both sides get ride_complete
  const riderDone = once(rider, "ride_complete");
  const driverDone = once(driver, "ride_complete");
  rider.emit("ride_complete");
  await Promise.all([riderDone, driverDone]);
  console.log("6. ride_complete delivered to both sides");

  driver.close();
  rider.close();
  console.log("SMOKE TEST PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
