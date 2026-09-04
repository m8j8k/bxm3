// Cloudflare Worker: Emily's BxM2/BxM3 commute board.
//
//   ?mode=work  Broadway/W 260 St  -> 5 Av/E 78 St      (BxM3, Midtown-bound)
//   ?mode=home  Madison Av/E 80 St -> Riverdale/Yonkers (BxM2 + BxM3)
//
// Secret: MTA_KEY. It is never echoed in any response, and no request URL
// (which carries the key) is ever included in output.

const CACHE_S = 25;

const MODES = {
  work: {
    label: "To work",
    stop: "100609",
    stop_name: "Broadway / W 260 St",
    routes: ["BXM3"],
    // 100609 is the Midtown-only side of the corner (100594 is the Yonkers
    // side), so a bus reported here is already direction-correct. We still
    // positively exclude return-trip headsigns.
    reject: /YONKERS|RIVERDALE|GETTY/,
    direction_ref: "1",
    legacy_fields: true,
    targets: {
      BXM3: {
        ids: ["404303"],
        names: ["5 AV/E 78 ST"],
        label: "5 Av / E 78 St",
      },
    },
  },
  home: {
    label: "Home",
    stop: "450543",
    stop_name: "Madison Av / E 80 St",
    routes: ["BXM2", "BXM3"],
    // Madison Av runs uptown, so this stop serves the Bronx-bound trips.
    // Anything still signed for Midtown is laying over or wrong-direction.
    reject: /MIDTOWN/,
    direction_ref: null,
    targets: {
      BXM3: {
        ids: ["100594"],
        names: ["BROADWAY/W 260 ST"],
        label: "Broadway / W 260 St",
      },
      BXM2: {
        ids: ["100464", "100466", "100467"],
        names: [
          "RIVERDALE AV/W 259 ST",
          "RIVERDALE AV/W 261 ST",
          "RIVERDALE AV/W 263 ST",
        ],
        label: "Riverdale Av / W 259–263 St",
      },
    },
  },
};

const DEFAULT_MODE = "work";
const LINE_REF = { BXM2: "MTABC_BXM2", BXM3: "MTABC_BXM3" };
const PRETTY = { BXM2: "BxM2", BXM3: "BxM3" };

const cache = new Map();

const api = (path, params) =>
  "https://bustime.mta.info/api/siri/" + path + ".json?" + new URLSearchParams(params);

// ---------------------------------------------------------------- helpers

// SIRI v2 JSON is inconsistent: a field can be a plain string, a number, an
// array of natural-language strings, or an object like {content, lang}.
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
const norm = (v) => up(v).replace(/[^A-Z0-9]/g, "");

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
  const a = norm(value);
  return a !== "" && a === norm(name);
};

// Which of the mode's allowed routes is this journey, if any?
const routeOf = (j, allowed) => {
  const published = norm(j.PublishedLineName);
  for (const r of allowed) if (published === r) return r;
  const lineRef = norm(j.LineRef);
  for (const r of allowed) if (lineRef.endsWith(r)) return r;
  for (const r of allowed) if (published.endsWith(r) || lineRef.includes(r)) return r;
  return null;
};

const directionOk = (j, cfg) => {
  const s = [j.DestinationName, j.DirectionName, j.DestinationRef, j.PublishedLineName]
    .map(up)
    .join(" ");
  return !cfg.reject.test(s);
};

// Number("") === 0, so an absent field must be rejected before coercion -
// otherwise a missing stop count is reported as a confident "0 stops away".
const numOrNull = (v) => {
  const s = text(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const distances = (call) => call?.Extensions?.Distances ?? {};

// Real-time first; fall back to the timetable only as a last resort, and
// report which was used so the UI can label scheduled times honestly.
const firstTime = (call) => {
  const live = call?.ExpectedArrivalTime ?? call?.ExpectedDepartureTime ?? null;
  if (live) return { time: live, scheduled: false };
  const aimed = call?.AimedArrivalTime ?? call?.AimedDepartureTime ?? null;
  if (aimed) return { time: aimed, scheduled: true };
  return { time: null, scheduled: false };
};

const onwardCalls = (j) => arr(j?.OnwardCalls?.OnwardCall);

const matchesTarget = (call, spec) =>
  spec.ids.some((id) => stopIdMatches(call.StopPointRef, id)) ||
  spec.names.some((n) => stopNameMatches(call.StopPointName, n));

const findTarget = (calls, spec, afterIdx = -1) => {
  if (!spec) return null;
  const i = calls.findIndex((c, idx) => idx > afterIdx && matchesTarget(c, spec));
  return i < 0 ? null : calls[i];
};

function normalizeBus(j, routeKey, boardingCall, targetCall, spec, source) {
  const board = firstTime(boardingCall);
  const target = firstTime(targetCall);
  return {
    route: PRETTY[routeKey] ?? routeKey,
    route_key: routeKey,
    vehicle: (text(j.VehicleRef) || "").split("_").pop() || null,
    dest: text(j.DestinationName),
    proximity:
      text(distances(boardingCall).PresentableDistance) ||
      text(boardingCall?.ArrivalProximityText) ||
      "",
    stops_away:
      numOrNull(distances(boardingCall).StopsFromCall) ??
      numOrNull(boardingCall?.NumberOfStopsAway),
    board_time: board.time,
    board_scheduled: board.scheduled,
    target_time: target.time,
    target_scheduled: target.scheduled,
    target_found: !!targetCall,
    target_label: spec?.label ?? null,
    source,
  };
}

const byBoardTime = (a, b) => {
  if (!a.board_time) return 1;
  if (!b.board_time) return -1;
  return new Date(a.board_time) - new Date(b.board_time);
};

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

// ------------------------------------------------------- StopMonitoring

async function stopMonitoring(env, cfg) {
  const data = await fetchJson(
    api("stop-monitoring", {
      key: env.MTA_KEY,
      version: "2",
      OperatorRef: "MTA",
      MonitoringRef: cfg.stop,
      StopMonitoringDetailLevel: "calls",
      MaximumNumberOfCallsOnwards: "60",
    })
  );

  const delivery = arr(data?.Siri?.ServiceDelivery?.StopMonitoringDelivery)[0];
  const visits = arr(delivery?.MonitoredStopVisit);
  const rejected = { route: 0, direction: 0 };
  const buses = [];

  for (const v of visits) {
    const j = v.MonitoredVehicleJourney ?? {};
    const routeKey = routeOf(j, cfg.routes);
    if (!routeKey) {
      rejected.route++;
      continue;
    }
    if (!directionOk(j, cfg)) {
      rejected.direction++;
      continue;
    }
    const spec = cfg.targets[routeKey];
    buses.push(
      normalizeBus(
        j,
        routeKey,
        j.MonitoredCall ?? {},
        findTarget(onwardCalls(j), spec),
        spec,
        "stop"
      )
    );
  }

  return {
    buses: buses.sort(byBoardTime),
    error: errorText(data, delivery),
    raw_visit_count: visits.length,
    rejected,
    samples: visits.slice(0, 3).map((v) => sample(v.MonitoredVehicleJourney ?? {}, cfg)),
  };
}

// ---------------------------------------------------- VehicleMonitoring

async function vehicleMonitoring(env, cfg) {
  const rejected = { route: 0, direction: 0, no_boarding_stop: 0, no_target_stop: 0 };
  const buses = [];
  const samples = [];
  let raw = 0;
  let error = null;

  for (const routeKey of cfg.routes) {
    const params = {
      key: env.MTA_KEY,
      version: "2",
      OperatorRef: "MTA",
      LineRef: LINE_REF[routeKey],
      VehicleMonitoringDetailLevel: "calls",
      MaximumStopVisits: "10",
      MaximumNumberOfCallsOnwards: "60",
    };
    if (cfg.direction_ref) params.DirectionRef = cfg.direction_ref;

    const data = await fetchJson(api("vehicle-monitoring", params));
    const delivery = arr(data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery)[0];
    const activities = arr(delivery?.VehicleActivity);
    raw += activities.length;
    error = error ?? errorText(data, delivery);
    for (const a of activities.slice(0, 2)) samples.push(sample(a.MonitoredVehicleJourney ?? {}, cfg));

    for (const a of activities) {
      const j = a.MonitoredVehicleJourney ?? {};
      if (routeOf(j, [routeKey]) !== routeKey) {
        rejected.route++;
        continue;
      }
      if (!directionOk(j, cfg)) {
        rejected.direction++;
        continue;
      }

      const calls = onwardCalls(j);
      const boardingIdx = calls.findIndex((c) => stopIdMatches(c.StopPointRef, cfg.stop));
      if (boardingIdx < 0) {
        rejected.no_boarding_stop++;
        continue;
      }
      // The target must still be ahead of Emily's boarding stop on this
      // vehicle's remaining path - that also guarantees direction.
      const spec = cfg.targets[routeKey];
      const targetCall = findTarget(calls, spec, boardingIdx);
      if (!targetCall) {
        rejected.no_target_stop++;
        continue;
      }

      buses.push(normalizeBus(j, routeKey, calls[boardingIdx], targetCall, spec, "route"));
    }
  }

  return { buses: buses.sort(byBoardTime), error, raw_vehicle_count: raw, rejected, samples };
}

// ------------------------------------------------------------ diagnostics
// Field-shape sample: only MTA feed values, never the key or a request URL.
const shape = (v) =>
  v == null ? "null" : Array.isArray(v) ? "array[" + v.length + "]" : typeof v;

function sample(j, cfg) {
  const mc = j.MonitoredCall ?? {};
  const calls = onwardCalls(j);
  const routeKey = routeOf(j, cfg.routes);
  const target = routeKey ? findTarget(calls, cfg.targets[routeKey]) : null;
  return {
    LineRef: { shape: shape(j.LineRef), text: text(j.LineRef) },
    PublishedLineName: { shape: shape(j.PublishedLineName), text: text(j.PublishedLineName) },
    DestinationName: { shape: shape(j.DestinationName), text: text(j.DestinationName) },
    DirectionRef: text(j.DirectionRef),
    VehicleRef: text(j.VehicleRef),
    MonitoredCall_StopPointRef: text(mc.StopPointRef),
    MonitoredCall_StopPointName: { shape: shape(mc.StopPointName), text: text(mc.StopPointName) },
    MonitoredCall_Distances: mc?.Extensions?.Distances ?? null,
    MonitoredCall_NumberOfStopsAway: shape(mc?.NumberOfStopsAway),
    onward_call_count: calls.length,
    route_key: routeKey,
    direction_ok: directionOk(j, cfg),
    target_call: target ? text(target.StopPointRef) + " | " + text(target.StopPointName) : null,
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

    const params = new URL(request.url).searchParams;
    const requested = (params.get("mode") ?? DEFAULT_MODE).toLowerCase();
    const modeKey = MODES[requested] ? requested : DEFAULT_MODE;
    const cfg = MODES[modeKey];
    const debug = params.get("debug") === "1";

    const now = Date.now();
    const hit = cache.get(modeKey);
    if (!debug && hit && now - hit.t < CACHE_S * 1000) {
      return new Response(hit.body, { headers: cors });
    }

    let out;

    try {
      const stop = await stopMonitoring(env, cfg);
      let buses = stop.buses;
      let route = null;

      if (!buses.length) {
        route = await vehicleMonitoring(env, cfg);
        buses = route.buses;
      }

      const body = {
        updated: new Date().toISOString(),
        mode: modeKey,
        mode_label: cfg.label,
        stop: cfg.stop,
        stop_name: cfg.stop_name,
        routes: cfg.routes.map((r) => PRETTY[r] ?? r),
        buses,
        error: stop.error ?? route?.error ?? null,
        source: buses.length ? buses[0].source : null,
        diagnostics: {
          raw_visit_count: stop.raw_visit_count,
          raw_vehicle_count: route?.raw_vehicle_count ?? null,
          stop_rejected: stop.rejected,
          vehicle_rejected: route?.rejected ?? null,
        },
      };

      // Back-compat for any home-screen copy still running the old page.
      if (cfg.legacy_fields) {
        body.raw_visit_count = stop.raw_visit_count;
        body.raw_vehicle_count = route?.raw_vehicle_count ?? null;
        body.dest_stop = cfg.targets.BXM3.ids[0];
        body.line = LINE_REF.BXM3;
        body.target_stop = cfg.targets.BXM3.names[0];
        for (const b of body.buses) {
          b.arrive_260 = b.board_time;
          b.arrive_260_scheduled = b.board_scheduled;
          b.arrive_78 = b.target_time;
          b.arrive_78_scheduled = b.target_scheduled;
          b.line = b.route;
        }
      }

      if (debug) {
        body.debug = {
          stop_samples: stop.samples,
          vehicle_samples: route?.samples ?? null,
        };
      }

      out = JSON.stringify(body);
      if (!debug) cache.set(modeKey, { t: now, body: out });
    } catch (e) {
      out = JSON.stringify({
        updated: null,
        mode: modeKey,
        mode_label: cfg.label,
        stop: cfg.stop,
        stop_name: cfg.stop_name,
        routes: cfg.routes.map((r) => PRETTY[r] ?? r),
        buses: [],
        error: String(e && e.message ? e.message : e),
        source: null,
      });
    }

    return new Response(out, { headers: cors });
  },
};
