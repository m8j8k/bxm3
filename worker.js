// Cloudflare Worker: proxies MTA StopMonitoring, hides the key, adds CORS.
// Set secret:  MTA_KEY  (dashboard > Worker > Settings > Variables, type "secret")

const STOP = "100609";          // BROADWAY/W 260 ST (Midtown-bound)
const LINE = "MTABC_BXM3";
const DEST = "5 AV/E 78 ST";
const CACHE_S = 25;             // serve cached for 25s so N viewers = 1 MTA call

let cache = { t: 0, body: null };

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    const now = Date.now();
    if (cache.body && now - cache.t < CACHE_S * 1000) {
      return new Response(cache.body, { headers: cors });
    }
    const url =
      "https://bustime.mta.info/api/siri/stop-monitoring.json?" +
      new URLSearchParams({
        key: env.MTA_KEY,
        version: "2",
        OperatorRef: "MTABC",
        MonitoringRef: STOP,
        LineRef: LINE,
        StopMonitoringDetailLevel: "calls",
      });
    let out;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await r.json();
      const visits =
        data?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0]
          ?.MonitoredStopVisit ?? [];
      const buses = visits.map((v) => {
        const j = v.MonitoredVehicleJourney ?? {};
        const mc = j.MonitoredCall ?? {};
        const oc = (j.OnwardCalls?.OnwardCall ?? []).find(
          (c) => (c.StopPointName ?? "").toUpperCase() === DEST
        );
        return {
          vehicle: (j.VehicleRef ?? "?").split("_").pop(),
          dest: j.DestinationName ?? "",
          proximity: mc.ArrivalProximityText ?? "",
          stops_away: mc.NumberOfStopsAway ?? null,
          arrive_260: mc.ExpectedArrivalTime ?? null,
          arrive_78: oc?.ExpectedArrivalTime ?? null,
        };
      });
      out = JSON.stringify({ updated: new Date().toISOString(), buses });
      cache = { t: now, body: out };
    } catch (e) {
      out = JSON.stringify({ updated: null, buses: [], error: String(e) });
    }
    return new Response(out, { headers: cors });
  },
};
