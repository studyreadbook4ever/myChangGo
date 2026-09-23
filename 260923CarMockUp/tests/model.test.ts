import test from "node:test";
import assert from "node:assert/strict";
import {
  arrivalFor,
  clockTime,
  elapsedDrive,
  freshState,
  INITIAL_EVENTS,
  INITIAL_TRIPS,
  maintenanceSlot,
  median,
  parseSavedState,
  personalResidual,
  planTrip,
} from "../src/model.ts";

test("departure includes actual driving residual, parking, walking and chosen buffer", () => {
  const plan = planTrip(INITIAL_EVENTS[2], INITIAL_TRIPS);
  assert.equal(plan.residual, 3);
  assert.equal(plan.drive, 15);
  assert.equal(plan.duration, 23);
  assert.equal(clockTime(plan.departure), "18:00");
  assert.equal(
    clockTime(
      planTrip({ ...INITIAL_EVENTS[2], buffer: 10 }, INITIAL_TRIPS).departure,
    ),
    "17:57",
  );
});
test("median is robust to outliers and leaves input intact", () => {
  const values = [100, 3, 2, 3, 4];
  assert.equal(median(values), 3);
  assert.deepEqual(values, [100, 3, 2, 3, 4]);
  assert.equal(median([2, 4]), 3);
  assert.equal(median([]), 0);
});
test("personalization excludes unrelated destinations and disrupted journeys", () => {
  assert.equal(
    personalResidual(
      [...INITIAL_TRIPS, { ...INITIAL_TRIPS[0], actual: 90, rerouted: true }],
      "office",
    ),
    3,
  );
  assert.equal(personalResidual(INITIAL_TRIPS, "cafe"), 0);
  assert.equal(
    planTrip({ ...INITIAL_EVENTS[2], destination: "cafe" }, INITIAL_TRIPS)
      .drive,
    8,
  );
});
test("the full scenario preserves the announced arrival times", () => {
  const plan = planTrip(INITIAL_EVENTS[2], INITIAL_TRIPS);
  assert.equal(clockTime(arrivalFor(1080, plan.duration, "ready")), "18:23");
  assert.equal(clockTime(arrivalFor(1080, plan.duration, "traffic")), "18:35");
  assert.equal(clockTime(arrivalFor(1080, plan.duration, "rerouted")), "18:26");
  assert.equal(elapsedDrive(15, 0, 0.3), elapsedDrive(15, 12, 0.3));
  assert.equal(elapsedDrive(15, 12, 0.3), elapsedDrive(15, 3, 0.3));
  assert.equal(elapsedDrive(15, 3, 1), 18);
});
test("maintenance suggestion checks actual calendar conflicts including partial overlaps", () => {
  assert.equal(maintenanceSlot(INITIAL_EVENTS)?.time, "10:00");
  const occupied = [
    ...INITIAL_EVENTS,
    { ...INITIAL_EVENTS[0], date: "2026-09-26", time: "09:45", duration: 90 },
  ];
  assert.equal(maintenanceSlot(occupied)?.date, "2026-09-24");
  const boundary = [
    ...INITIAL_EVENTS,
    { ...INITIAL_EVENTS[0], date: "2026-09-26", time: "09:00", duration: 60 },
  ];
  assert.equal(maintenanceSlot(boundary)?.time, "10:00");
});
test("saved state roundtrips and broken state recovers without crashing", () => {
  const state = freshState();
  state.mileage = 9843.8;
  assert.deepEqual(parseSavedState(JSON.stringify(state)), state);
  assert.deepEqual(parseSavedState("{broken"), freshState());
  assert.deepEqual(
    parseSavedState(
      JSON.stringify({
        ...state,
        trips: [
          {
            destination: "office",
            distance: 3,
            actual: 15,
            baseline: 12,
            id: "bad",
          },
        ],
      }),
    ),
    freshState(),
  );
  assert.deepEqual(
    parseSavedState(JSON.stringify({ ...state, parking: "constructor" })),
    freshState(),
  );
  assert.deepEqual(
    parseSavedState(
      JSON.stringify({
        ...state,
        events: [{ ...state.events[0], date: "2026-02-31" }],
      }),
    ),
    freshState(),
  );
  assert.deepEqual(
    parseSavedState(JSON.stringify({ ...state, events: [] })).events,
    [],
  );
});
test("clock formatting supports midnight boundary", () => {
  assert.equal(clockTime(-5), "23:55");
  assert.equal(clockTime(1445), "00:05");
});

test("keeping a congested route does not distort normal driving habits", () => {
  const kept = {
    ...INITIAL_TRIPS[0],
    id: "kept",
    actual: 27,
    rerouted: false,
    trafficDelay: 12,
  };
  assert.equal(personalResidual([kept, ...INITIAL_TRIPS], "office"), 3);
  const state = { ...freshState(), trips: [kept, ...INITIAL_TRIPS] };
  assert.deepEqual(parseSavedState(JSON.stringify(state)), state);
});
