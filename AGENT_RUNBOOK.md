# RUNBOOK: Finish deploying the BxM3 bus tracker

You are an autonomous agent with shell access. Execute top to bottom. Stop and
report to Max if a REQUIRED SECRET is missing or a CHECKPOINT fails twice.

## Context
- Purpose: web page showing real-time BxM3 bus arrivals at Broadway/W 260 St
  (stop 100609, Midtown-bound) with projected arrival at 5 Av/E 78 St.
- Already done: GitHub repo `m8j8k/bxm3` exists with `index.html`, `worker.js`,
  `README.md`. index.html line ~20 contains `WORKER_URL = "CHANGE_ME"`.
- Your job: (1) deploy worker.js as a Cloudflare Worker with the MTA key as a
  secret, (2) point index.html at it, (3) ensure GitHub Pages is serving,
  (4) verify end-to-end, (5) report.

## REQUIRED SECRETS (ask Max, do not proceed without)
- `MTA_KEY`            — MTA Bus Time API key (uuid format)
- `CLOUDFLARE_API_TOKEN` — create at dash.cloudflare.com/profile/api-tokens,
  template "Edit Cloudflare Workers"
- `GITHUB_TOKEN`       — fine-grained PAT scoped to repo m8j8k/bxm3 with
  permissions: Contents (RW) AND Pages (RW). NOTE: the token Max used earlier
  lacks Pages permission; ask him for a new one with Pages included, or fall
  back to step 4B.

## Step 1 — Deploy the Cloudflare Worker
```bash
mkdir -p ~/bxm3-worker && cd ~/bxm3-worker
curl -sf -o worker.js https://raw.githubusercontent.com/m8j8k/bxm3/main/worker.js
test -s worker.js || { echo "FAIL: worker.js download"; exit 1; }

cat > wrangler.toml <<'EOF'
name = "bxm3"
main = "worker.js"
compatibility_date = "2026-01-01"
EOF

npx --yes wrangler@latest deploy 2>&1 | tee deploy.log
# expected output contains a line like:
#   https://bxm3.<subdomain>.workers.dev
```
- Export `CLOUDFLARE_API_TOKEN` in env before running.
- If wrangler asks for account_id: run `npx wrangler whoami`, add
  `account_id = "<id>"` to wrangler.toml, retry.
- Capture the deployed URL from deploy.log into `$WORKER_URL`.

Set the secret (non-interactive):
```bash
echo "$MTA_KEY" | npx wrangler secret put MTA_KEY
```
This triggers a redeploy. Wait 10s.

## CHECKPOINT A — Worker returns live data
```bash
curl -sf "$WORKER_URL" | python3 -m json.tool
```
PASS criteria:
- HTTP 200, valid JSON, top-level keys `updated` and `buses`.
- If `buses` is non-empty: every entry's `dest` must contain "MIDTOWN"
  (case-insensitive). If any says "YONKERS": the stop constant is wrong side
  of the street. STOP. Report to Max: "stop 100609 is Yonkers-bound, need the
  opposite-direction stop code." Do not guess a replacement code.
- `buses` may legitimately be empty outside service hours (BxM3 runs roughly
  5am–1am weekdays, reduced weekends). If empty, defer bus-content checks to
  CHECKPOINT C but continue.
- If `arrive_78` is null on every bus while `buses` is non-empty, the
  destination-stop name constant may not match MTA's spelling. Fetch the raw
  feed spelling:
  ```bash
  curl -s "https://bustime.mta.info/api/siri/stop-monitoring.json?key=$MTA_KEY&version=2&OperatorRef=MTABC&MonitoringRef=100609&LineRef=MTABC_BXM3&StopMonitoringDetailLevel=calls" \
   | python3 -c "import sys,json;d=json.load(sys.stdin);[print(c['StopPointName']) for v in d['Siri']['ServiceDelivery']['StopMonitoringDelivery'][0]['MonitoredStopVisit'] for c in v['MonitoredVehicleJourney'].get('OnwardCalls',{}).get('OnwardCall',[])]"
  ```
  Find the entry for 5 Av / 78 St, note exact spelling, edit DEST in worker.js
  to match, redeploy, re-run CHECKPOINT A.

## Step 2 — Point index.html at the worker
```bash
H="Authorization: Bearer $GITHUB_TOKEN"
API="https://api.github.com/repos/m8j8k/bxm3/contents/index.html"
curl -sf -H "$H" "$API" > cur.json
SHA=$(python3 -c "import json;print(json.load(open('cur.json'))['sha'])")
python3 - <<PY
import base64, json
raw = base64.b64decode(json.load(open('cur.json'))['content'])
new = raw.replace(b'CHANGE_ME', b'$WORKER_URL')
assert new != raw, "CHANGE_ME not found - already replaced? inspect manually"
open('new.b64','w').write(base64.b64encode(new).decode())
PY
curl -sf -X PUT -H "$H" "$API" \
  -d "{\"message\":\"set worker URL\",\"content\":\"$(cat new.b64)\",\"sha\":\"$SHA\"}" \
  -o /dev/null -w "update index.html: %{http_code}\n"
```
Expect 200. If the assert fires, GET the file and inspect — Max may have
already edited it; if a valid workers.dev URL is present, skip ahead.

## Step 3 — Ensure GitHub Pages is on
```bash
curl -s -o /dev/null -w "%{http_code}" -H "$H" https://api.github.com/repos/m8j8k/bxm3/pages
```
- 200 → already enabled, continue.
- 404 → enable it:
  ```bash
  curl -s -X POST -H "$H" https://api.github.com/repos/m8j8k/bxm3/pages \
    -d '{"source":{"branch":"main","path":"/"}}' -o /dev/null -w "%{http_code}\n"
  ```
  Expect 201.
- 403 on the POST → token lacks Pages permission → **Step 4B**: message Max:
  "Enable Pages manually: github.com/m8j8k/bxm3 → Settings → Pages → Deploy
  from branch → main / root → Save. Reply done." Wait for confirmation.

## CHECKPOINT B — Site is live and wired
Pages builds take 1–3 min after the index.html commit. Poll up to 5 min:
```bash
for i in $(seq 1 10); do
  BODY=$(curl -sL https://m8j8k.github.io/bxm3/)
  echo "$BODY" | grep -q "workers.dev" && break
  sleep 30
done
echo "$BODY" | grep -q "BxM3" || { echo "FAIL: page not serving"; exit 1; }
echo "$BODY" | grep -q "CHANGE_ME" && { echo "FAIL: stale build or step 2 failed"; exit 1; }
```

## CHECKPOINT C — End-to-end during service hours
Run (or schedule yourself to run) between 06:00 and 22:00 America/New_York:
```bash
curl -sf "$WORKER_URL"
```
- `buses` non-empty, `dest` MIDTOWN, at least one bus with non-null
  `arrive_78` → full PASS.
- Persistently empty across 3 checks an hour apart during weekday daytime →
  report FAIL with the raw JSON.

## Step 5 — Final report to Max
Include:
1. Worker URL and Pages URL (https://m8j8k.github.io/bxm3/)
2. Checkpoint A/B/C results (pass/fail + evidence snippet)
3. Any deviations taken
4. Reminder: revoke the GitHub token used earlier in chat AND this one
   (github.com → Settings → Developer settings → tokens), and rotate the MTA
   key if it was ever pasted anywhere public (it appeared in a chat).

## Hard rules
- Never commit MTA_KEY, tokens, or wrangler credentials to the repo.
- Never print secrets in the final report.
- Do not modify any repo other than m8j8k/bxm3.
- If CHECKPOINT A shows YONKERS, stop — wrong-direction data pushed live would
  be worse than no tracker.
