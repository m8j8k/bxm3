# BxM3 on GitHub Pages + Cloudflare Worker

## 1. Worker (holds the key)
Dashboard route — no CLI needed:
1. dash.cloudflare.com → Workers & Pages → Create → Worker → name it `bxm3` → Deploy
2. Edit code → paste `worker.js` → Deploy
3. Settings → Variables and Secrets → Add → type **Secret**, name `MTA_KEY`, paste key → Deploy
4. Note the URL: `https://bxm3.<subdomain>.workers.dev` — open it, you should see JSON

## 2. Pages (the UI)
1. New GitHub repo (public), add `index.html`
2. Edit `WORKER_URL` at the top of the script to your workers.dev URL
3. Repo Settings → Pages → Source: main branch, / root
4. Site appears at `https://<user>.github.io/<repo>/`

Emily: open the URL in Safari → Share → Add to Home Screen. Looks like an app.

## Checks
- Worker JSON `buses[].dest` should say MIDTOWN. If YONKERS, edit STOP in worker.js to the other 260 St code.
- If `arrive_78` is always null, the DEST string doesn't match MTA's spelling — check an entry's OnwardCalls in the raw feed and fix DEST.
- Worker free tier: 100k req/day; page polls twice a minute, cache makes MTA see ~2 req/min max. Nowhere close.
