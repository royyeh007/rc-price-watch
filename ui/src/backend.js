// Two ways the dashboard can run:
//   local  - served by watcher/server.py, which exposes /api/* over the data files
//   static - served by GitHub Pages; data comes from exported JSON files and config.json is
//            read/written in the repository through the GitHub API (token kept in this browser)

const TOKEN_KEY = "rcpw.githubToken";
const BOOKING_KEY = "rcpw.bookingId";

function readLocal(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function writeLocal(key, value) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* private mode etc. */ }
}

// Per-browser settings that must never end up in the repository.
export const local = {
  get token() { return readLocal(TOKEN_KEY); },
  set token(v) { writeLocal(TOKEN_KEY, v); },
  get bookingId() { return readLocal(BOOKING_KEY); },
  set bookingId(v) { writeLocal(BOOKING_KEY, v); },
};

export function parsePlannerUrl(url) {
  try {
    const q = new URL(url).searchParams;
    const ship = q.get("shipCode");
    const sd = (q.get("sailDate") || "").replace(/-/g, "");
    if (!ship || sd.length !== 8) return null;
    return { ship, sail_date: `${sd.slice(0, 4)}-${sd.slice(4, 6)}-${sd.slice(6, 8)}`, booking_id: q.get("bookingId") || "" };
  } catch {
    return null;
  }
}

async function json(url, opts) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

class LocalBackend {
  mode = "local";
  repo = "";
  canEdit() { return true; }
  canCheck() { return true; }
  summary() { return json("/api/summary"); }
  async series(key) { return (await json(`/api/series?key=${encodeURIComponent(key)}`)).series; }
  config() { return json("/api/config"); }
  saveConfig(patch) { return json("/api/config", { method: "PUT", body: JSON.stringify(patch) }); }
  async startCheck() { return (await json("/api/check", { method: "POST" })).started; }
  checkStatus() { return json("/api/check"); }
}

const utf8ToB64 = (s) => btoa(unescape(encodeURIComponent(s)));
const b64ToUtf8 = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));

class StaticBackend {
  mode = "static";

  constructor(summary) {
    this.cached = summary;
    this.repo = summary.repo || "";
    this.branch = summary.branch || "main";
    this.api = `https://api.github.com/repos/${this.repo}`;
    this.pending = null; // {dispatchedAt, baseline} while a "Check now" is in flight
  }

  canEdit(token = local.token) { return !!token && !!this.repo; }
  canCheck(token = local.token) { return this.canEdit(token); }

  headers(extra = {}) {
    const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...extra };
    if (local.token) h.Authorization = `Bearer ${local.token}`;
    return h;
  }

  async summary() {
    const r = await fetch(`data/summary.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`data/summary.json: ${r.status}`);
    this.cached = await r.json();
    return this.cached;
  }

  async series(key, file) {
    const r = await fetch(`data/series/${file}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`series ${file}: ${r.status}`);
    return (await r.json()).series;
  }

  async _configFile() {
    const r = await fetch(`${this.api}/contents/config.json?ref=${this.branch}&t=${Date.now()}`, { headers: this.headers(), cache: "no-store" });
    if (!r.ok) throw new Error(`GitHub API ${r.status} reading config.json`);
    const j = await r.json();
    return { sha: j.sha, config: JSON.parse(b64ToUtf8(j.content)) };
  }

  async config() {
    try {
      return (await this._configFile()).config;
    } catch {
      return this.cached.config || {}; // snapshot taken when the site was built
    }
  }

  async saveConfig(patch) {
    if (!this.canEdit()) throw new Error("Add a GitHub token in Settings to make changes.");
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { sha, config } = await this._configFile();
      const next = { ...config, ...patch };
      const r = await fetch(`${this.api}/contents/config.json`, {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: `dashboard: update ${Object.keys(patch).join(", ")}`,
          content: utf8ToB64(JSON.stringify(next, null, 2) + "\n"),
          sha, branch: this.branch,
        }),
      });
      if (r.ok) return next;
      last = r.status;
      if (r.status !== 409) break; // 409 = someone else committed meanwhile; retry once
    }
    throw new Error(`GitHub API ${last} saving config.json (token needs Contents: read and write on ${this.repo})`);
  }

  async startCheck() {
    if (!this.canCheck()) throw new Error("Add a GitHub token in Settings to run a check.");
    const r = await fetch(`${this.api}/actions/workflows/check.yml/dispatches`, {
      method: "POST", headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ref: this.branch }),
    });
    if (r.status !== 204) throw new Error(`GitHub API ${r.status} starting the workflow (token needs Actions: read and write)`);
    this.pending = { dispatchedAt: Date.now(), baseline: this.cached.generated_at };
    return true;
  }

  async checkStatus() {
    if (!this.pending) return { running: false, last_output: "" };
    const { dispatchedAt, baseline } = this.pending;
    if (Date.now() - dispatchedAt > 10 * 60 * 1000) {
      this.pending = null;
      return { running: false, last_output: `Gave up waiting after 10 minutes. See https://github.com/${this.repo}/actions` };
    }
    const r = await fetch(`${this.api}/actions/runs?event=workflow_dispatch&per_page=1&t=${Date.now()}`, { headers: this.headers(), cache: "no-store" });
    const run = r.ok ? (await r.json()).workflow_runs?.[0] : null;
    const ours = run && new Date(run.created_at).getTime() >= dispatchedAt - 120000;
    if (!ours) return { running: true, last_output: "Waiting for GitHub Actions to start…" };
    if (run.status !== "completed") return { running: true, last_output: `GitHub Actions: ${run.status.replace("_", " ")}… (${run.html_url})` };
    if (run.conclusion !== "success") {
      this.pending = null;
      return { running: false, last_output: `GitHub Actions run ${run.conclusion}: ${run.html_url}` };
    }
    const s = await this.summary();
    if (s.generated_at === baseline) return { running: true, last_output: "Check finished; waiting for GitHub Pages to publish the new data…" };
    this.pending = null;
    return { running: false, last_output: `Updated. Data as of ${s.generated_at}.` };
  }
}

export async function detectBackend() {
  try {
    const r = await fetch("data/summary.json", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) return new StaticBackend(await r.json());
  } catch { /* not static */ }
  return new LocalBackend();
}
