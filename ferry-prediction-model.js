/**
 * Ferry departure prediction policy and evaluation
 * =================================================
 *
 * IMPORTANT MAINTENANCE NOTE
 * --------------------------
 * This comment is the design record for the production predictor. Whenever
 * the algorithm, its evidence priority, route profiles, or accuracy metric is
 * changed, update this comment in the same commit so it continues to describe
 * the code below accurately. Do not let it become a historical description of
 * a model that is no longer running.
 *
 * Purpose
 * -------
 * The dashboard must answer a physical question: which vessel can next leave
 * each terminal, and when will it actually be ready? WSF's timetable is useful
 * context but is not an observation that a sailing occurred, nor is its vessel
 * assignment guaranteed to survive delays, cancellations, swaps, one-boat
 * operation, or crew constraints. Prediction therefore runs only on the
 * server, against the freshest durable history/GPS snapshot. The browser only
 * displays server-resolved results.
 *
 * Evidence and decision order
 * ---------------------------
 * 1. A reconciled GPS/LeftDock departure is truth and is never predicted over.
 * 2. Fresh vessel state establishes the next physically possible terminal and
 *    time: a docked vessel must finish its measured turnaround; an inbound
 *    vessel must arrive, unload, and load. This is supplied as `availableMs`.
 * 3. The ordinary departure estimate is max(now, vessel-ready, scheduled slot).
 *    Operators may load early but normally do not leave before the advertised
 *    time. When the service has fallen behind, the state machine retains the
 *    overdue unserved slot briefly so a ready boat can keep moving rather than
 *    being incorrectly assigned to a much later timetable row. Once that slot's
 *    same-terminal successor is also overdue, or later observed same-terminal
 *    service has superseded it, the old slot is stale history rather than a
 *    live prediction candidate.
 * 4. Future sailings are a physical chain. After a projected departure, that
 *    vessel must cross and turn around before it can depart the other side.
 *    The next-leg duration blends a route baseline, the next scheduled gap,
 *    and recent observed cadence. Clinton/Mukilteo gives recent operations and
 *    schedule equal influence because its frequent service tends to run as
 *    quickly as practical when delayed. Bainbridge weights the physical route
 *    baseline heavily because its lower frequency and crew/slot constraints
 *    make schedule gaps less reliable. Inputs are clamped around the physical
 *    baseline so a missing or malformed schedule row cannot create a wild ETA;
 *    it is never allowed below the physical crossing-plus-turnaround minimum.
 * 5. A GPS state older than two hours is not permitted to anchor a vessel. The
 *    normal collector is much more frequent; this guard protects gross-error
 *    tails after feed/storage failures without changing collection itself.
 *
 * Why this is deliberately conservative
 * --------------------------------------
 * Offline replay showed that occasional wrong sailing identity and stale state
 * dominate RMSE far more than sub-minute tuning. The policy therefore prefers
 * a plausible later physical time when evidence conflicts. It does not invent
 * a cancellation from silence; an unserved row may simply be skipped once a
 * later observed departure proves which sailing actually occurred.
 *
 * Route profiles
 * --------------
 * The weights sum to one and apply to the vessel's next opposite-terminal leg:
 *
 *   Clinton/Mukilteo: baseline .25, schedule .375, recent cadence .375
 *   Seattle/Bainbridge: baseline .75, schedule .1875, recent cadence .0625
 *
 * The baseline is route crossing time plus the conservative default turnaround;
 * the first live availability still uses the server's measured recent dock
 * turnaround when one exists. Recent cadence is based only on already observed
 * departures in the current operational day, so no future information leaks
 * into a live prediction.
 *
 * Daily 60-minute evaluation
 * --------------------------
 * For every verified actual departure, evaluation chooses the single recorded
 * model snapshot closest to 60 minutes beforehand, accepting 57.5–62.5 minutes.
 * One point per sailing prevents a day with more one-minute snapshots from
 * receiving more statistical weight. The report publishes signed-error RMSE,
 * MAE, 95th-percentile absolute error, worst absolute error, within-five-minute
 * rate, and tail rates. Its histogram uses absolute-error buckets 0–5, 5–10,
 * 10–15, 15–20, 20–30, 30–45, and 45+ minutes. Boundary values belong to the
 * lower bucket (for example, exactly five minutes is counted in 0–5).
 * RMSE remains the optimization metric, while the 30+ and 45+ buckets make the
 * rare operationally nonsensical estimates visible instead of averaging them
 * away.
 */

const MAX_VESSEL_EVIDENCE_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_OVERDUE_UNSERVED_SLOT_CYCLES = 2;
const SIXTY_MINUTE_TARGET = 60;
const SIXTY_MINUTE_WINDOW = 2.5;

export const FERRY_PREDICTION_MODEL_ID = 'physical-state-route-v1';

export const FERRY_ROUTE_MODEL_PROFILES = Object.freeze({
  whidbey: Object.freeze({ baselineWeight: 0.25, scheduleWeight: 0.375, recentWeight: 0.375 }),
  bainbridge: Object.freeze({ baselineWeight: 0.75, scheduleWeight: 0.1875, recentWeight: 0.0625 }),
});

function departureKey(fromTerminalId, scheduledDepartureMs) {
  return `${fromTerminalId}:${scheduledDepartureMs}`;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values = [], proportion = 0.95) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(proportion * sorted.length) - 1);
  return sorted[index];
}

function recentObservedLegMs(trips = [], nowMs, fallbackMs) {
  const departures = trips
    .filter(trip => Number.isFinite(trip?.actualDepartureMs) && trip.actualDepartureMs <= nowMs)
    .sort((a, b) => a.actualDepartureMs - b.actualDepartureMs);
  const gaps = [];
  for (let i = 1; i < departures.length; i += 1) {
    const previous = departures[i - 1];
    const current = departures[i];
    if (previous.fromTerminalId === current.fromTerminalId) continue;
    const gap = current.actualDepartureMs - previous.actualDepartureMs;
    if (gap >= fallbackMs * 0.5 && gap <= fallbackMs * 2) gaps.push(gap);
  }
  return median(gaps.slice(-6)) || fallbackMs;
}

function scheduledOppositeLegMs(trips, trip, fallbackMs) {
  const next = trips.find(candidate =>
    candidate.fromTerminalId === trip.toTerminalId &&
    candidate.scheduledDepartureMs > trip.scheduledDepartureMs
  );
  if (!next) return fallbackMs;
  const gap = next.scheduledDepartureMs - trip.scheduledDepartureMs;
  return Number.isFinite(gap) && gap > 0 ? gap : fallbackMs;
}

function nextLegMs({ profile, baselineMs, scheduleMs, recentMs }) {
  const blended = baselineMs * profile.baselineWeight +
    scheduleMs * profile.scheduleWeight +
    recentMs * profile.recentWeight;
  return Math.round(Math.max(baselineMs, Math.min(baselineMs * 1.5, blended)));
}

/**
 * Produce future departure assignments from fresh physical vessel states.
 * The caller remains responsible for deriving GPS state and turnaround time;
 * this function owns the route policy and sailing/vessel assignment chain.
 */
export function buildOperationalDeparturePredictions({
  routeKey,
  nowMs,
  trips = [],
  vesselStates = [],
  observedDepartureKeys = [],
  operationalCycleMs,
  departureMatchMs,
  horizonMs,
}) {
  const predictions = {};
  if (!Number.isFinite(nowMs) || !Number.isFinite(operationalCycleMs)) return predictions;
  const profile = FERRY_ROUTE_MODEL_PROFILES[routeKey] || FERRY_ROUTE_MODEL_PROFILES.whidbey;
  const orderedTrips = trips
    .filter(trip => Number.isFinite(trip?.scheduledDepartureMs))
    .sort((a, b) => a.scheduledDepartureMs - b.scheduledDepartureMs);
  const observedKeys = new Set(observedDepartureKeys);
  const usedKeys = new Set(observedKeys);
  const latestObservedScheduledByTerminal = new Map();
  const nextScheduledByKey = new Map();
  const previousTripByTerminal = new Map();
  const scheduleBounds = new Map();
  for (const trip of orderedTrips) {
    const key = departureKey(trip.fromTerminalId, trip.scheduledDepartureMs);
    const previousTrip = previousTripByTerminal.get(trip.fromTerminalId);
    if (previousTrip) {
      nextScheduledByKey.set(
        departureKey(previousTrip.fromTerminalId, previousTrip.scheduledDepartureMs),
        trip.scheduledDepartureMs
      );
    }
    previousTripByTerminal.set(trip.fromTerminalId, trip);
    if (observedKeys.has(key) || Number.isFinite(trip?.actualDepartureMs)) {
      latestObservedScheduledByTerminal.set(
        trip.fromTerminalId,
        Math.max(
          latestObservedScheduledByTerminal.get(trip.fromTerminalId) || -Infinity,
          trip.scheduledDepartureMs
        )
      );
    }
    const bounds = scheduleBounds.get(trip.fromTerminalId) || {
      firstScheduledMs: trip.scheduledDepartureMs,
      finalScheduledMs: trip.scheduledDepartureMs,
    };
    bounds.firstScheduledMs = Math.min(bounds.firstScheduledMs, trip.scheduledDepartureMs);
    bounds.finalScheduledMs = Math.max(bounds.finalScheduledMs, trip.scheduledDepartureMs);
    scheduleBounds.set(trip.fromTerminalId, bounds);
  }
  const recentMs = recentObservedLegMs(orderedTrips, nowMs, operationalCycleMs);
  const states = vesselStates
    .filter(state =>
      Number.isFinite(state?.availableTerminalId) &&
      Number.isFinite(state?.availableMs) &&
      Number.isFinite(state?.observedAtMs) &&
      nowMs - state.observedAtMs <= MAX_VESSEL_EVIDENCE_AGE_MS
    )
    .map(state => ({ ...state }))
    .sort((a, b) => a.availableMs - b.availableMs);

  let guard = 0;
  while (states.length && guard < 96) {
    guard += 1;
    states.sort((a, b) => a.availableMs - b.availableMs || String(a.vesselName).localeCompare(String(b.vesselName)));
    const state = states.shift();
    const projectedBaseMs = Math.max(nowMs, state.availableMs);
    const overdueCutoffMs = projectedBaseMs - operationalCycleMs * MAX_OVERDUE_UNSERVED_SLOT_CYCLES;
    const latestObservedScheduledMs = latestObservedScheduledByTerminal.get(state.availableTerminalId) || -Infinity;
    const terminalTrips = orderedTrips.filter(trip => {
      const key = departureKey(trip.fromTerminalId, trip.scheduledDepartureMs);
      const nextScheduledMs = nextScheduledByKey.get(key);
      const skippedBySuccessor = Number.isFinite(nextScheduledMs) &&
        nextScheduledMs <= projectedBaseMs - departureMatchMs;
      return trip.fromTerminalId === state.availableTerminalId &&
        !trip.actualDepartureMs &&
        !skippedBySuccessor &&
        trip.scheduledDepartureMs >= overdueCutoffMs &&
        trip.scheduledDepartureMs >= latestObservedScheduledMs - departureMatchMs;
    });
    const bounds = scheduleBounds.get(state.availableTerminalId);
    if (!terminalTrips.length || !bounds) continue;
    let referenceTrip = null;
    for (const trip of terminalTrips) {
      const key = departureKey(trip.fromTerminalId, trip.scheduledDepartureMs);
      if (usedKeys.has(key)) continue;
      if (trip.scheduledDepartureMs <= projectedBaseMs) referenceTrip = trip;
      else if (!referenceTrip) referenceTrip = trip;
      if (trip.scheduledDepartureMs > projectedBaseMs) break;
    }
    if (!referenceTrip) continue;
    const projectedDepartureMs = Math.max(nowMs, state.availableMs, referenceTrip.scheduledDepartureMs);
    const closeMs = bounds.finalScheduledMs + operationalCycleMs;
    if (projectedDepartureMs > closeMs || projectedDepartureMs > nowMs + horizonMs) continue;
    const key = departureKey(referenceTrip.fromTerminalId, referenceTrip.scheduledDepartureMs);
    predictions[key] = {
      direction: referenceTrip.direction,
      fromTerminalId: referenceTrip.fromTerminalId,
      toTerminalId: referenceTrip.toTerminalId,
      scheduledDepartureMs: referenceTrip.scheduledDepartureMs,
      scheduledReferenceMs: referenceTrip.scheduledDepartureMs,
      displayScheduledMs: referenceTrip.scheduledDepartureMs,
      projectedDepartureMs,
      delayMs: Math.max(0, projectedDepartureMs - referenceTrip.scheduledDepartureMs),
      vesselName: state.vesselName,
      vesselId: state.vesselId,
      sourceStatus: state.sourceStatus,
      sourceObservedAtMs: state.observedAtMs,
      basis: state.basis || 'gps-vessel-state',
      modelId: FERRY_PREDICTION_MODEL_ID,
    };
    usedKeys.add(key);
    const scheduleMs = scheduledOppositeLegMs(orderedTrips, referenceTrip, operationalCycleMs);
    state.availableTerminalId = referenceTrip.toTerminalId;
    state.availableMs = projectedDepartureMs + nextLegMs({ profile, baselineMs: operationalCycleMs, scheduleMs, recentMs });
    state.sourceStatus = 'operational-chain';
    state.basis = `route-weighted-${routeKey || 'default'}-chain`;
    states.push(state);
  }
  return predictions;
}

const ACCURACY_BUCKETS = Object.freeze([
  { min: 0, max: 5, label: '0–5' },
  { min: 5, max: 10, label: '5–10' },
  { min: 10, max: 15, label: '10–15' },
  { min: 15, max: 20, label: '15–20' },
  { min: 20, max: 30, label: '20–30' },
  { min: 30, max: 45, label: '30–45' },
  { min: 45, max: Infinity, label: '45+' },
]);

function bucketForError(errorMinutes) {
  const absolute = Math.abs(errorMinutes);
  return ACCURACY_BUCKETS.find((bucket, index) =>
    index === 0 ? absolute >= bucket.min && absolute <= bucket.max : absolute > bucket.min && absolute <= bucket.max
  ) || ACCURACY_BUCKETS[ACCURACY_BUCKETS.length - 1];
}

/** Select one near-60-minute estimate per actual sailing and score the day. */
export function summarizeSixtyMinuteAccuracy(series = []) {
  const samples = [];
  for (const trip of series) {
    const candidates = (trip?.points || []).filter(point =>
      Number.isFinite(point?.minutesBeforeDeparture) &&
      Number.isFinite(point?.modelErrorMinutes) &&
      Math.abs(point.minutesBeforeDeparture - SIXTY_MINUTE_TARGET) <= SIXTY_MINUTE_WINDOW
    );
    candidates.sort((a, b) =>
      Math.abs(a.minutesBeforeDeparture - SIXTY_MINUTE_TARGET) - Math.abs(b.minutesBeforeDeparture - SIXTY_MINUTE_TARGET) ||
      b.observedAtMs - a.observedAtMs
    );
    if (!candidates.length) continue;
    const point = candidates[0];
    samples.push({
      key: trip.key,
      fromTerminalId: trip.fromTerminalId,
      fromTerminalName: trip.fromTerminalName,
      actualDepartureMs: trip.actualDepartureMs,
      observedAtMs: point.observedAtMs,
      minutesBeforeDeparture: point.minutesBeforeDeparture,
      errorMinutes: point.modelErrorMinutes,
      absoluteErrorMinutes: Math.abs(point.modelErrorMinutes),
    });
  }
  const absoluteErrors = samples.map(sample => sample.absoluteErrorMinutes);
  const squaredErrors = samples.map(sample => sample.errorMinutes ** 2);
  const count = samples.length;
  const buckets = ACCURACY_BUCKETS.map(bucket => {
    const bucketCount = samples.filter(sample => bucketForError(sample.errorMinutes) === bucket).length;
    return {
      label: bucket.label,
      minMinutes: bucket.min,
      maxMinutes: Number.isFinite(bucket.max) ? bucket.max : null,
      count: bucketCount,
      proportion: count ? bucketCount / count : 0,
    };
  });
  return {
    targetMinutesBeforeDeparture: SIXTY_MINUTE_TARGET,
    selectionWindowMinutes: SIXTY_MINUTE_WINDOW,
    sampleCount: count,
    rmseMinutes: count ? Math.sqrt(squaredErrors.reduce((sum, value) => sum + value, 0) / count) : null,
    maeMinutes: count ? absoluteErrors.reduce((sum, value) => sum + value, 0) / count : null,
    p95AbsoluteErrorMinutes: percentile(absoluteErrors, 0.95),
    maxAbsoluteErrorMinutes: count ? Math.max(...absoluteErrors) : null,
    withinFiveMinutesProportion: count ? absoluteErrors.filter(value => value <= 5).length / count : null,
    overThirtyMinutesProportion: count ? absoluteErrors.filter(value => value > 30).length / count : null,
    overFortyFiveMinutesProportion: count ? absoluteErrors.filter(value => value > 45).length / count : null,
    buckets,
    samples,
  };
}
