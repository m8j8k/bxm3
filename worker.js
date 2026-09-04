// Cloudflare Worker: BxM3 bus board for Emily.
// Hides the MTA key, adds CORS, and projects Broadway/W 260 St -> 5 Av/E 78 St.
//
// Secret: MTA_KEY  (never echoed in any response)

const STOP = "100609";           // BROADWAY/W 260 ST, Midtown-bound side
const DEST_STOP = "404303";      // 5 AV/E 78 ST
const LINE = "MTABC_BXM3";
const DEST = "5 AV/E 78 ST";
const CACHE_S = 25;

let cache = { t: 0, body: null };

const api = (path, params) =>
  "https://bustime.mta.info/api/siri/" + path + ".json?" + new URLSearchParams(params);

// ---------------------------------------------------------------- helpers

// SIRI v2 JSON is inconsistent: a "name" field can be a plain string, a number,
// an array of natural-language strings, or an object like {content, lang}.
// text() flattens any of those into a plain string.
const text = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(" ");
  if (typeof v === "object") {
    for (const k of ["content", "value", "Value", "text", "$t", "Name", "name"]) {
      if (v[k] != null) return text(v[k]);
    }
    return Object.entries(v)
      .filter(([k, val]) => k !== "lang" && typeof val !== "object")
      .map(([, val]) => text(val))
      .filter(Boolean)
      .join(" ");
  }
  return "";
};

const up = (v) => text(v).toUpperCase();

// Some deliveries come back as a bare object instead of a one-element array.
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// "100609", "MTA_100609", "MTABC_100609" all match "100609".
const stopIdMatches = (value, id) => {
  const s = up(value);
  if (!s) return false;
  const want = String(id).toUpperCase();
  return s === want || s.endsWith("_" + want) || s.split(/[^A-Z0-9]+/).includes(want);
};

const stopNameMatches = (value, name) => {
  const a = up(value).replace(/[^A-Z0-9]/g, "");
  const b = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return a !== "" && a === b;
};

// BxM3 via PublishedLineName or LineRef ("MTABC_BXM3", "BxM3", ...).
const routeMatches = (j) => {
  const s = [j.PublishedLineName, j.LineRef, j.JourneyPatternRef]
    .map(up)
    .join(" ")
    .replace(/[^A-Z0-9]/g, "");
  return s.includes("BXM3");
};

// Direction. Stop 100609 is the Midtown-bound side of Broadway/W 260 St
// (100594 is the Yonkers side), so a bus reported AT this stop is already
// direction-correct. We therefore only need to positively exclude Yonkers
// headsigns; an unrecognised headsign is not treated as wrong-direction.
const midtownMatches = (j) => {
  const s = [j.DestinationName, j.DirectionName, j.DestinationRef, j.PublishedLineName]
    .map(up)
    .join(" ");
  if (/YONKERS/.test(s)) return false;
  return true;
};

const numOrNull = (v) => {
  const n = Number(text(v));
  return Number.isFinite(n) ? n : null;
};

const distances = (call) => call?.Extensions?.Distances ?? {};

// Real-time values first; fall back to the timetable only as a last resort,
// and report which one was used so the UI can label scheduled times honestly.
const firstTime = (call) => {
  const live = call?.ExpectedArrivalTime ?? call?.ExpectedDepartureTime ?? null;
  if (live) return { time: live, scheduled: false };
  const aimed = call?.AimedArrivalTime ?? call?.AimedDepartureTime ?? null;
  if (aimed) return { time: aimed, scheduled: true };
  return { time: null, scheduled: false };
};

const normalizeBus = (j, boardingCall, targetCall, source) => ({
  vehicle: (text(j.VehicleRef) || "?").split("_").pop(),
  line: text(j.PublishedLineName) || text(j.LineRef).split("_").pop(),
  dest: text(j.DestinationName),
  proximity:
    text(distances(boardingCall).PresentableDistance) ||
    text(boardingCall?.ArrivalProximityText) ||
    "",
  stops_away:
    numOrNull(distances(boardingCall).StopsFromCall) ??
    numOrNull(boardingCall?.NumberOfStopsAway),
  arrive_260: firstTime(boardingCall).time,
  arrive_260_scheduled: firstTime(boardingCall).scheduled,
  arrive_78: firstTime(targetCall).time,
  arrive_78_scheduled: firstTime(targetCall).scheduled,
  source,
});

const errorText = (data, delivery) => {
  const e =
    data?.Siri?.ServiceDelivery?.ErrorCondition ??
    delivery?.ErrorCondition ??
    delivery?.ErrorMessage ??
    null;
  if (!e) return null;
  const t = text(e.Description ?? e.ErrorText ?? e.OtherError ?? e);
  return t || null;
};

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("MTA HTTP " + r.status);
  return await r.json();
}

const onwardCalls = (j) => arr(j?.OnwardCalls?.OnwardCall);

const findTargetCall = (calls) =>
  calls.find(
    (c) => stopIdMatches(c.StopPointRef, DEST_STOP) || stopNameMatches(c.StopPointName, DEST)
  ) ?? null;

// ------------------------------------------------------- StopMonitoring

async function stopMonitoring(env) {
  const data = await fetchJson(
    api("stop-monitoring", {
      key: env.MTA_KEY,
      version: "2",
      OperatorRef: "MTA",
      MonitoringRef: STOP,
      StopMonitoringDetailLevel: "calls",
      MaximumNumberOfCallsOnwards: "60",
    })
  );

  const delivery = arr(data?.Siri?.ServiceDelivery?.StopMonitoringDelivery)[0];
  const visits = arr(delivery?.MonitoredStopVisit);
  const rejected = { route: 0, direction: 0 };

  const buses = visits
    .map((v) => {
      const j = v.MonitoredVehicleJourney ?? {};
      if (!routeMatches(j)) {
        rejected.route++;
        return null;
      }
      if (!midtownMatches(j)) {
        rejected.direction++;
        return null;
      }
      return normalizeBus(
        j,
        j.MonitoredCall ?? {},
        findTargetCall(onwardCalls(j)),
        "stop"
      );
    })
    .filter(Boolean);

  return {
    buses,
    error: errorText(data, delivery),
    raw_visit_count: visits.length,
    rejected,
    samples: visits.slice(0, 3).map((v) => sample(v.MonitoredVehicleJourney ?? {})),
  };
}

// ---------------------------------------------------- VehicleMonitoring

async function vehicleMonitoring(env) {
  const data = await fetchJson(
    api("vehicle-monitoring", {
      key: env.MTA_KEY,
      version: "2",
      OperatorRef: "MTA",
      LineRef: LINE,
      DirectionRef: "1",
      VehicleMonitoringDetailLevel: "calls",
      MaximumStopVisits: "10",
      MaximumNumberOfCallsOnwards: "60",
    })
  );

  const delivery = arr(data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery)[0];
  const activities = arr(delivery?.VehicleActivity);
  const rejected = { route: 0, direction: 0, no_boarding_stop: 0, no_target_stop: 0 };

  const buses = activities
    .map((a) => {
      const j = a.MonitoredVehicleJourney ?? {};
      if (!routeMatches(j)) {
        rejected.route++;
        return null;
      }
      if (!midtownMatches(j)) {
        rejected.direction++;
        return null;
      }

      const calls = onwardCalls(j);
      const boardingIdx = calls.findIndex((c) => stopIdMatches(c.StopPointRef, STOP));
      if (boardingIdx < 0) {
        rejected.no_boarding_stop++;
        return null;
      }
      // 78th St must still be ahead of Emily's stop on this vehicle's path.
      const targetIdx = calls.findIndex(
        (c, i) =>
          i > boardingIdx &&
          (stopIdMatches(c.StopPointRef, DEST_STOP) || stopNameMatches(c.StopPointName, DEST))
      );
      if (targetIdx < 0) {
        rejected.no_target_stop++;
        return null;
      }

      return normalizeBus(j, calls[boardingIdx], calls[targetIdx], "route");
    })
    .filter(Boolean);

  return {
    buses,
    error: errorText(data, delivery),
    raw_vehicle_count: activities.length,
    rejected,
    samples: activities.slice(0, 3).map((a) => sample(a.MonitoredVehicleJourney ?? {})),
  };
}

// ------------------------------------------------------------ diagnostics
// Field-shape sample. Contains only MTA feed values - never the key or URL.
const shape = (v) =>
  v == null ? "null" : Array.isArray(v) ? "array[" + v.length + "]" : typeof v;

function sample(j) {
  const mc = j.MonitoredCall ?? {};
  const calls = onwardCalls(j);
  return {
    LineRef: { shape: shape(j.LineRef), text: text(j.LineRef) },
    PublishedLineName: { shape: shape(j.PublishedLineName), text: text(j.PublishedLineName) },
    DestinationName: { shape: shape(j.DestinationName), text: text(j.DestinationName) },
    DirectionRef: text(j.DirectionRef),
    VehicleRef: text(j.VehicleRef),
    MonitoredCall_StopPointRef: text(mc.StopPointRef),
    MonitoredCall_StopPointName: {
      shape: shape(mc.StopPointName),
      text: text(mc.StopPointName),
    },
    onward_call_count: calls.length,
    onward_first_3: calls
      .slice(0, 3)
      .map((c) => text(c.StopPointRef) + " | " + text(c.StopPointName)),
    target_call: (() => {
      const c = findTargetCall(calls);
      return c ? text(c.StopPointRef) + " | " + text(c.StopPointName) : null;
    })(),
    route_ok: routeMatches(j),
    direction_ok: midtownMatches(j),
  };
}

// ------------------------------------------------------------------ entry

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };

    const debug = new URL(request.url).searchParams.get("debug") === "1";
    const now = Date.now();

    if (!debug && cache.body && now - cache.t < CACHE_S * 1000) {
      return new Response(cache.body, { headers: cors });
    }

    let out;

    try {
      const stop = await stopMonitoring(env);
      let buses = stop.buses;
      let route = null;

      if (!buses.length) {
        route = await vehicleMonitoring(env);
        buses = route.buses;
      }

      const body = {
        updated: new Date().toISOString(),
        buses,
        error: stop.error ?? route?.error ?? null,
        raw_visit_count: stop.raw_visit_count,
        raw_vehicle_count: route?.raw_vehicle_count ?? null,
        stop: STOP,
        dest_stop: DEST_STOP,
        line: LINE,
        target_stop: DEST,
        source: buses.length ? buses[0].source : null,
      };

      if (debug) {
        body.debug = {
          stop_rejected: stop.rejected,
          stop_samples: stop.samples,
          vehicle_rejected: route?.rejected ?? null,
          vehicle_samples: route?.samples ?? null,
        };
      }

      out = JSON.stringify(body);
      if (!debug) cache = { t: now, body: out };
    } catch (e) {
      out = JSON.stringify({
        updated: null,
        buses: [],
        error: String(e && e.message ? e.message : e),
        stop: STOP,
        dest_stop: DEST_STOP,
        line: LINE,
        target_stop: DEST,
        source: null,
      });
    }

    return new Response(out, { headers: cors });
  },
};
