import React, { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { detectBackend, local, parsePlannerUrl } from "./backend.js";

const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
const pct = (n) => `${Math.round(n * 100)}%`;
const shortDate = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
const splitKey = (key) => {
  const i = key.indexOf(":");
  return i < 0 ? ["", key] : [key.slice(0, i), key.slice(i + 1)];
};

// Has the price moved at all since tracking started?
const hasMoved = (r) => r.max != null && r.lowest != null && r.max > r.lowest;
// At the lowest price recorded since tracking started (only meaningful once the price has moved).
const atLowest = (r) => hasMoved(r) && r.latest != null && r.latest <= r.lowest;
const LowestPill = () => <span className="pill neutral" style={{ marginLeft: 6 }} title="Lowest price seen since tracking started">at lowest</span>;

// Price you paid for a product: exact key first, then legacy loose name match.
function bookedFor(key, booked) {
  if (!booked) return null;
  if (booked[key]) return Number(booked[key]);
  const k = key.toLowerCase();
  for (const [name, price] of Object.entries(booked)) {
    if (price && !name.includes(":") && k.includes(name.toLowerCase())) return Number(price);
  }
  return null;
}

export default function App() {
  const [backend, setBackend] = useState(null);
  const [summary, setSummary] = useState(null);
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState(null);
  const [check, setCheck] = useState({ running: false, last_output: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [token, setTokenState] = useState(local.token);
  const [bookingId, setBookingIdState] = useState(local.bookingId);

  useEffect(() => { detectBackend().then(setBackend); }, []);

  const refresh = async (b = backend) => {
    if (!b) return;
    try {
      const [s, c, k] = await Promise.all([b.summary(), b.config(), b.checkStatus()]);
      setSummary(s);
      setConfig(c);
      setCheck(k);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  useEffect(() => { if (backend) refresh(backend); }, [backend]);
  useEffect(() => {
    if (!check.running || !backend) return;
    const t = setInterval(async () => {
      try {
        const s = await backend.checkStatus();
        setCheck(s);
        if (!s.running) refresh();
      } catch (e) {
        setCheck({ running: false, last_output: String(e.message || e) });
      }
    }, backend.mode === "static" ? 6000 : 2000);
    return () => clearInterval(t);
  }, [check.running, backend]);

  // A legacy local config may still carry the booking id inside its planner URL.
  useEffect(() => {
    if (!bookingId && config?.planner_url) {
      const p = parsePlannerUrl(config.planner_url);
      if (p?.booking_id) setBookingId(p.booking_id);
    }
  }, [config]);

  const setToken = (v) => { local.token = v; setTokenState(v); };
  const setBookingId = (v) => { local.bookingId = v; setBookingIdState(v); };

  const editable = !!backend && backend.canEdit(token);
  const sailing = summary?.sailing;
  const siteBookingId = summary?.booking_id || "";
  const effectiveBookingId = siteBookingId || bookingId;
  const urlFor = (path) => (path && sailing && effectiveBookingId
    ? `https://www.royalcaribbean.com${path}?bookingId=${encodeURIComponent(effectiveBookingId)}&shipCode=${sailing.ship}&sailDate=${sailing.sail_date.replace(/-/g, "")}`
    : null);

  const watchSet = useMemo(() => new Set(config?.watch || []), [config]);

  const rows = useMemo(() => {
    if (!summary) return [];
    return Object.entries(summary.products)
      .map(([key, p]) => {
        const [cat, name] = splitKey(key);
        return {
          key, cat, name, ...p,
          url: urlFor(p.path),
          catName: summary.categories?.[cat] || cat || "other",
          booked: bookedFor(key, config?.booked),
          watched: watchSet.has(key),
        };
      })
      .sort((a, b) => a.catName.localeCompare(b.catName) || a.name.localeCompare(b.name));
  }, [summary, config, watchSet, effectiveBookingId]);

  const watching = useMemo(() => rows.filter((r) => r.watched || r.booked != null), [rows]);

  useEffect(() => {
    if (selected || !rows.length) return;
    setSelected((watching[0] || rows[0]).key);
  }, [rows, watching, selected]);

  const current = rows.find((r) => r.key === selected);

  const saveConfig = async (patch) => {
    setSaving(true);
    try {
      const c = await backend.saveConfig(patch);
      setConfig(c);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
      backend.config().then(setConfig).catch(() => {}); // undo the optimistic update, keep the error visible
    } finally {
      setSaving(false);
    }
  };

  const toggleWatch = (key) => {
    if (!editable) return setError("Add a GitHub token in Settings to star products.");
    const list = config.watch || [];
    const next = watchSet.has(key) ? list.filter((k) => k !== key) : [...list, key];
    setConfig({ ...config, watch: next });
    saveConfig({ watch: next });
  };

  const setBooked = (key, value) => {
    if (!editable) return setError("Add a GitHub token in Settings to enter prices.");
    const booked = { ...(config.booked || {}) };
    if (value === "" || value == null || Number.isNaN(Number(value))) delete booked[key];
    else booked[key] = Number(value);
    setConfig({ ...config, booked });
    saveConfig({ booked });
  };

  const runCheck = async () => {
    try {
      if (await backend.startCheck()) setCheck({ running: true, last_output: "Starting…" });
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  if (!backend || !config || !summary) return <div className="app"><div className="empty">{error || "Loading…"}</div></div>;

  const nCats = Object.keys(summary.categories || {}).length;
  const movedLastCheck = rows.filter((r) => r.prev != null && r.latest !== r.prev).length;
  const isStatic = backend.mode === "static";
  const rowProps = { selected, onSelect: setSelected, onToggle: toggleWatch, editable };

  return (
    <div className="app">
      <header>
        <h1>
          Cruise Price Watch
          <small>
            {rows.length} products · {nCats} categories · {summary.checks} checks logged · {movedLastCheck} price {movedLastCheck === 1 ? "change" : "changes"} at the last check
            {isStatic && summary.generated_at ? ` · data as of ${shortDate(summary.generated_at)}` : ""}
          </small>
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="status">
            {check.running ? (check.last_output || "Checking prices…") : summary.last_ts ? `Last check ${shortDate(summary.last_ts)}` : "No checks yet"}
          </span>
          <button onClick={runCheck} disabled={check.running || !backend.canCheck(token)}
            title={backend.canCheck(token) ? (isStatic ? "Runs the GitHub Actions workflow (2–3 minutes)" : "Run a check now") : "Add a GitHub token in Settings to run checks"}>
            {check.running ? "Running…" : "Check now"}
          </button>
        </div>
      </header>

      {error && <div className="card" style={{ color: "var(--bad)" }}>{error}</div>}
      {isStatic && !editable && (
        <div className="card notice">
          Read-only view. To star products, enter what you paid, or run a check from here, add a GitHub token under <b>Settings → This browser only</b>.
        </div>
      )}

      {rows.length === 0 ? (
        <section className="card"><div className="empty">No prices yet. Set the sailing in Settings, then run a check.</div></section>
      ) : (
        <>
          <Watchlist rows={watching} onBooked={setBooked} {...rowProps} />
          <TopDrops rows={rows} checks={summary.checks} {...rowProps} />
          {current && <Detail row={current} backend={backend} version={summary.generated_at || summary.checks} />}
          <Catalog rows={rows} categories={summary.categories} {...rowProps} />
        </>
      )}

      <Settings config={config} categories={summary.categories} onSave={saveConfig} saving={saving} backend={backend}
        editable={editable} token={token} setToken={setToken} bookingId={bookingId} setBookingId={setBookingId}
        siteBookingId={siteBookingId} />

      {check.last_output && !check.running && (
        <section className="card">
          <h2>Last check output</h2>
          <pre>{check.last_output}</pre>
        </section>
      )}
    </div>
  );
}

// The product's most recent price movement: "▼ $12.00 · Oct 22, 12 PM" (hover for the old price).
function LastChange({ row }) {
  if (!row.changed_ts || row.before_change == null || row.latest == null) {
    return <span className="muted" title="No change since tracking started">—</span>;
  }
  const d = row.latest - row.before_change;
  return (
    <span style={{ color: d < 0 ? "var(--good)" : "var(--bad)", whiteSpace: "nowrap" }}
      title={`${money(row.before_change)} → ${money(row.latest)} on ${new Date(row.changed_ts).toLocaleString()}`}>
      {d < 0 ? "▼" : "▲"} {money(Math.abs(d))} <span className="muted">· {shortDate(row.changed_ts)}</span>
    </span>
  );
}

function Star({ on, onClick, editable }) {
  return (
    <button className={`star ${on ? "on" : ""}`} disabled={!editable}
      title={!editable ? "Add a GitHub token in Settings to change this" : on ? "Stop watching" : "Watch this product"}
      onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {on ? "★" : "☆"}
    </button>
  );
}

// Product name plus a link that opens the product's page in the Cruise Planner.
function ProductName({ row, linkName = false }) {
  if (!row.url) return <span>{row.name}</span>;
  const stop = (e) => e.stopPropagation();
  return linkName ? (
    <a className="ext name" href={row.url} target="_blank" rel="noopener noreferrer" onClick={stop} title="Open in Cruise Planner">{row.name} ↗</a>
  ) : (
    <span>{row.name}<a className="ext" href={row.url} target="_blank" rel="noopener noreferrer" onClick={stop} title="Open in Cruise Planner">↗</a></span>
  );
}

function PaidInput({ value, onCommit, editable }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const commit = () => { if (String(v) !== String(value ?? "")) onCommit(v); };
  return (
    <input className="paid" type="number" step="0.01" min="0" placeholder="—" value={v} disabled={!editable}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
  );
}

function Watchlist({ rows, selected, onSelect, onToggle, onBooked, editable }) {
  return (
    <section className="card">
      <h2>Watching · {rows.length}</h2>
      {rows.length === 0 ? (
        <div className="empty">
          Nothing selected yet. Click ☆ next to any product below to watch it.
          You'll get a phone alert only when a watched product's price goes down.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th><th>Product</th><th>Category</th>
              <th className="num">Now</th><th className="num">Lowest seen</th><th className="num">You paid</th><th>Status</th><th>Last change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const belowBooked = r.booked != null && r.latest != null && r.latest < r.booked;
              const atLow = atLowest(r);
              return (
                <tr key={r.key} className={r.key === selected ? "active" : ""} onClick={() => onSelect(r.key)}>
                  <td><Star on={r.watched} onClick={() => onToggle(r.key)} editable={editable} /></td>
                  <td><ProductName row={r} /></td>
                  <td className="muted">{r.catName}</td>
                  <td className="num"><b>{money(r.latest)}</b></td>
                  <td className="num">{money(r.lowest)}</td>
                  <td className="num"><PaidInput value={r.booked} onCommit={(v) => onBooked(r.key, v)} editable={editable} /></td>
                  <td>
                    {belowBooked && <span className="pill good">rebook: save {money(r.booked - r.latest)}</span>}
                    {!belowBooked && atLow && <span className="pill neutral">at lowest</span>}
                    {!belowBooked && !atLow && hasMoved(r) && <span className="pill bad">▲ {money(r.latest - r.lowest)} above low</span>}
                    {!belowBooked && !hasMoved(r) && <span className="muted">no change yet</span>}
                  </td>
                  <td><LastChange row={r} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>
        Alerts only when a price goes down. For something you already booked, enter what you paid and you're notified only when the
        price drops below it (Royal Caribbean lets you cancel and rebook at the lower price). Products without a paid price alert on any drop.
      </p>
    </section>
  );
}

const WINDOWS = [["all", "All time"], ["7d", "Last 7 days"], ["24h", "Last 24 hours"]];

function TopDrops({ rows, checks, selected, onSelect, onToggle, editable }) {
  const [win, setWin] = useState("all");
  const cutoff = win === "all" ? 0 : Date.now() - (win === "7d" ? 7 : 1) * 86400000;
  const drops = rows
    .filter((r) => r.latest != null && r.max != null && r.latest < r.max)
    .filter((r) => !cutoff || (r.changed_ts && new Date(r.changed_ts).getTime() >= cutoff))
    .map((r) => ({ ...r, drop: r.max - r.latest, pct: (r.max - r.latest) / r.max }))
    .sort((a, b) => b.pct - a.pct || b.drop - a.drop)
    .slice(0, 20);

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ marginBottom: 0 }}>Top price drops</h2>
        <div className="seg">
          {WINDOWS.map(([id, label]) => (
            <button key={id} className={win === id ? "on" : ""} onClick={() => setWin(id)}>{label}</button>
          ))}
        </div>
      </div>
      <p className="muted">
        Every product, compared with the highest price recorded for it since tracking started. Click a name to open it in the Cruise Planner.
      </p>
      {drops.length === 0 ? (
        <div className="empty">
          {win === "all"
            ? `No drops yet. No product is below its highest recorded price (${checks} ${checks === 1 ? "check" : "checks"} so far).`
            : "No price changes in this period."}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th></th><th>Product</th><th>Category</th>
              <th className="num">Was</th><th className="num">Now</th><th className="num">Drop</th><th>Last change</th>
            </tr>
          </thead>
          <tbody>
            {drops.map((r) => (
              <tr key={r.key} className={r.key === selected ? "active" : ""} onClick={() => onSelect(r.key)}>
                <td><Star on={r.watched} onClick={() => onToggle(r.key)} editable={editable} /></td>
                <td><ProductName row={r} linkName /></td>
                <td className="muted">{r.catName}</td>
                <td className="num muted">{money(r.max)}</td>
                <td className="num"><b>{money(r.latest)}</b>{atLowest(r) && <LowestPill />}</td>
                <td className="num"><span className="pill good">▼ {money(r.drop)} · {pct(r.pct)}</span></td>
                <td className="muted">
                  {r.changed_ts ? `${r.before_change > r.latest ? "▼" : "▲"} ${shortDate(r.changed_ts)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Detail({ row, backend, version }) {
  const [series, setSeries] = useState([]);
  useEffect(() => {
    let live = true;
    backend.series(row.key, row.file).then((s) => live && setSeries(s)).catch(() => {});
    return () => { live = false; };
  }, [row.key, version]);

  return (
    <section className="card">
      <h2>{row.catName} · <ProductName row={row} linkName /></h2>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 }} className="muted">
        <span>Now <b>{money(row.latest)}</b></span>
        <span>Lowest seen <b>{money(row.lowest)}</b></span>
        <span>Highest seen <b>{money(row.max)}</b></span>
        <span>You paid <b>{money(row.booked)}</b>
          {row.booked != null && row.latest < row.booked && (
            <> · <span style={{ color: "var(--good)" }}>rebook to save {money(row.booked - row.latest)}</span></>
          )}
        </span>
        <span>Tracked since <b>{row.first_ts ? shortDate(row.first_ts) : "—"}</b></span>
      </div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={series} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
            <XAxis dataKey="ts" tickFormatter={shortDate} stroke="var(--muted)" fontSize={12} />
            <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `$${v}`} stroke="var(--muted)" fontSize={12} width={60} />
            <Tooltip formatter={(v) => money(v)} labelFormatter={(l) => new Date(l).toLocaleString()}
              contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} />
            {row.booked != null && (
              <ReferenceLine y={row.booked} stroke="var(--good)" strokeDasharray="4 4"
                label={{ value: `paid ${money(row.booked)}`, fill: "var(--good)", fontSize: 12, position: "insideTopRight" }} />
            )}
            <Line type="stepAfter" dataKey="price" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>Price changes ({series.length})</summary>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>When</th><th className="num">Price</th><th className="num">Change</th></tr></thead>
          <tbody>
            {[...series].reverse().slice(0, 30).map((pt, i, arr) => {
              const next = arr[i + 1];
              const d = next ? pt.price - next.price : 0;
              return (
                <tr key={pt.ts}>
                  <td>{new Date(pt.ts).toLocaleString()}</td>
                  <td className="num">{money(pt.price)}</td>
                  <td className="num" style={{ color: d < 0 ? "var(--good)" : d > 0 ? "var(--bad)" : "var(--muted)" }}>
                    {d === 0 ? "—" : (d < 0 ? "−" : "+") + money(Math.abs(d))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </section>
  );
}

const SORTS = {
  name: (a, b) => a.catName.localeCompare(b.catName) || a.name.localeCompare(b.name),
  was: (a, b) => (b.max ?? 0) - (a.max ?? 0),
  now: (a, b) => (b.latest ?? 0) - (a.latest ?? 0),
  change: (a, b) => b.pct - a.pct || b.drop - a.drop,
  lowest: (a, b) => (b.lowest ?? 0) - (a.lowest ?? 0),
  changed: (a, b) => (b.changed_ts || "").localeCompare(a.changed_ts || ""),
};

function Catalog({ rows, categories, selected, onSelect, onToggle, editable }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [sort, setSort] = useState({ key: "name", dir: 1 });
  const catList = Object.entries(categories || {}).sort((a, b) => a[1].localeCompare(b[1]));
  const needle = q.trim().toLowerCase();
  const filtered = rows
    .filter((r) => (!cat || r.cat === cat) && (!needle || r.name.toLowerCase().includes(needle)))
    .map((r) => {
      const drop = r.max != null && r.latest != null ? r.max - r.latest : 0;
      return { ...r, drop, pct: drop > 0 ? drop / r.max : 0 };
    })
    .sort((a, b) => sort.dir * SORTS[sort.key](a, b));

  const sortBy = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const Th = ({ k, children, num }) => (
    <th className={`sortable ${num ? "num" : ""}`} onClick={() => sortBy(k)} title="Click to sort">
      {children}{sort.key === k ? (sort.dir === 1 ? " ▾" : " ▴") : ""}
    </th>
  );

  return (
    <section className="card">
      <h2>All products · {rows.length}</h2>
      <div className="toolbar">
        <input placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {catList.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Showing {filtered.length}. <b>Was</b> is the highest price recorded since tracking started, <b>Change</b> is how far below it the price is now,
        and <b>at lowest</b> marks products currently at the lowest price seen (once their price has moved at all).
        Click a column heading to sort. ☆ watches a product (you'll be notified when its price drops); click a row for its history; ↗ opens it in the Cruise Planner.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th></th><Th k="name">Product</Th><th>Category</th>
              <Th k="was" num>Was</Th><Th k="now" num>Now</Th><Th k="change" num>Change</Th><Th k="lowest" num>Lowest</Th><Th k="changed">Last change</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.key} className={r.key === selected ? "active" : ""} onClick={() => onSelect(r.key)}>
                <td><Star on={r.watched} onClick={() => onToggle(r.key)} editable={editable} /></td>
                <td><ProductName row={r} /></td>
                <td className="muted">{r.catName}</td>
                <td className="num muted">{money(r.max)}</td>
                <td className="num"><b>{money(r.latest)}</b></td>
                <td className="num">
                  {r.drop > 0
                    ? <span className="pill good">▼ {money(r.drop)} · {pct(r.pct)}</span>
                    : <span className="muted" title="At its highest recorded price">—</span>}
                </td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{money(r.lowest)}{atLowest(r) && <LowestPill />}</td>
                <td><LastChange row={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Settings({ config, categories, onSave, saving, backend, editable, token, setToken, bookingId, setBookingId, siteBookingId }) {
  const isStatic = backend.mode === "static";
  const [url, setUrl] = useState("");
  const [cats, setCats] = useState((config.categories || []).join(", "));
  const [topic, setTopic] = useState(config.ntfy_topic || "");
  const [tok, setTok] = useState(token || "");
  const [bid, setBid] = useState(bookingId || "");
  const [localMsg, setLocalMsg] = useState("");
  const [pushMsg, setPushMsg] = useState("");
  useEffect(() => {
    setCats((config.categories || []).join(", "));
    setTopic(config.ntfy_topic || "");
  }, [config]);
  const testPush = async () => {
    setPushMsg("Sending…");
    try {
      const r = await backend.testPush();
      setPushMsg(r.message || (r.ok ? "Sent." : "Failed."));
    } catch (e) {
      setPushMsg(String(e.message || e));
    }
  };
  useEffect(() => { setBid(bookingId || ""); }, [bookingId]);

  const ids = Object.keys(categories || {});
  const sailing = config.ship && config.sail_date ? `${config.ship} · ${config.sail_date}` : "not set";

  const save = () => {
    const patch = { categories: cats.split(",").map((s) => s.trim()).filter(Boolean) };
    if (url.trim()) {
      const p = parsePlannerUrl(url.trim());
      if (!p) return alert("That doesn't look like a Cruise Planner URL (it needs shipCode and sailDate).");
      patch.ship = p.ship;
      patch.sail_date = p.sail_date;
      if (p.booking_id) setBookingId(p.booking_id);
      setUrl("");
    }
    if (!isStatic) patch.ntfy_topic = topic.trim();
    onSave(patch);
  };
  const saveLocal = () => {
    setToken(tok.trim());
    setBookingId(bid.trim());
    setLocalMsg("Saved in this browser.");
    setTimeout(() => setLocalMsg(""), 2500);
  };

  return (
    <section className="card">
      <h2>Settings</h2>
      <div className="field">
        <label>
          Sailing: <b>{sailing}</b>. To change it, paste a Cruise Planner URL (open any category on royalcaribbean.com and copy the address bar).
          Only the ship and date are saved; the booking number stays in this browser.
        </label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}
          placeholder="https://www.royalcaribbean.com/account/cruise-planner/category/beverage?bookingId=…&shipCode=…&sailDate=…" />
      </div>
      <div className="field">
        <label>Categories to fetch, comma-separated (blank = all{ids.length ? `: ${ids.join(", ")}` : ""})</label>
        <input value={cats} onChange={(e) => setCats(e.target.value)} placeholder="all" spellCheck={false} />
      </div>
      {!isStatic && (
        <div className="field">
          <label>ntfy.sh topic (subscribe to this in the ntfy app on your phone). Stored in config.json; for GitHub Pages set the NTFY_TOPIC repository secret instead.</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="rc-star-0627-k7q2x9" />
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={save} disabled={saving || !editable} title={editable ? "" : "Add a GitHub token below first"}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        <button className="ghost" onClick={testPush} disabled={!backend.canCheck(token)}
          title={backend.canCheck(token) ? "Pushes a test message to your phone" : "Add a GitHub token below first"}>
          Send test notification
        </button>
        <span className="muted">{pushMsg}</span>
      </div>

      <h2 style={{ marginTop: 24 }}>This browser only</h2>
      <p className="muted" style={{ marginTop: 0 }}>Kept in this browser's local storage, never in the repository.</p>
      {siteBookingId ? (
        <p className="muted">
          Booking number: set {isStatic ? "by the BOOKING_ID repository secret" : "in config.local.json"}, so the ↗ links already work. It isn't shown here.
        </p>
      ) : (
        <div className="field">
          <label>Booking number (only used to build the ↗ links into your Cruise Planner)</label>
          <input type="password" autoComplete="off" value={bid} onChange={(e) => setBid(e.target.value)} placeholder="e.g. 1234567" spellCheck={false} style={{ maxWidth: 260 }} />
        </div>
      )}
      {isStatic && (
        <div className="field">
          <label>
            GitHub token for <b>{backend.repo}</b> (fine-grained token with <i>Contents: read and write</i> and <i>Actions: read and write</i> on this repository only).
            Needed to star products, enter paid prices and run checks. Create one at github.com → Settings → Developer settings → Personal access tokens.
          </label>
          <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="github_pat_…" spellCheck={false} />
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="ghost" onClick={saveLocal}>Save browser settings</button>
        <span className="muted">{localMsg}</span>
      </div>
      {isStatic && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Phone notifications: add a repository secret named <code>NTFY_TOPIC</code> at{" "}
          <a className="ext name" href={`https://github.com/${backend.repo}/settings/secrets/actions`} target="_blank" rel="noopener noreferrer">
            github.com/{backend.repo}/settings/secrets/actions ↗
          </a>{" "}
          with the topic you subscribed to in the ntfy app.
        </p>
      )}
    </section>
  );
}
