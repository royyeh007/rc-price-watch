"""Shared storage helpers: config, price history, lowest-seen prices, product ids, category names."""

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFIG_FILE = ROOT / "config.json"
CONFIG_EXAMPLE = ROOT / "config.example.json"
HISTORY_FILE = DATA_DIR / "history.jsonl"
LOWEST_FILE = DATA_DIR / "lowest.json"
CATEGORIES_FILE = DATA_DIR / "categories.json"
PRODUCTS_FILE = DATA_DIR / "products.json"     # product key -> {id, category, path}
DEBUG_DIR = DATA_DIR / "debug"

DEFAULT_CONFIG = {
    "ship": "",           # ship code from the Cruise Planner URL, e.g. "ST"
    "sail_date": "",      # "YYYY-MM-DD"
    "currency": "USD",
    "categories": [],     # category ids to fetch; empty = every category of the sailing
    "watch": [],          # product keys ("category:Title") starred in the dashboard; only these notify
    "booked": {},         # product key -> price you paid
    "ntfy_topic": "",     # local use only; on GitHub set the NTFY_TOPIC repository secret instead
    "appkey": "",         # overrides the built-in public API key if Royal Caribbean rotates it
    "planner_url": "",    # legacy: ship / sail_date are read from it when they are not set
    "pages": {},          # legacy
}
PRIVATE_KEYS = ("ntfy_topic", "appkey", "planner_url", "pages")   # never exported to the public dashboard


def load_config() -> dict:
    src = CONFIG_FILE if CONFIG_FILE.exists() else CONFIG_EXAMPLE
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if src.exists():
        cfg.update(json.loads(src.read_text(encoding="utf-8")))
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")


def public_config(cfg: dict) -> dict:
    return {k: v for k, v in cfg.items() if k not in PRIVATE_KEYS}


def parse_planner_url(url: str) -> dict:
    """
    Pull the sailing out of a Cruise Planner URL such as
    https://www.royalcaribbean.com/account/cruise-planner/category/beverage?bookingId=123&shipCode=ST&sailDate=20270627
    Returns {"ship", "sail_date" (YYYY-MM-DD), "booking_id" (may be "")}.
    """
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    sail = q.get("sailDate", "").replace("-", "")
    if not q.get("shipCode") or len(sail) != 8:
        raise ValueError(f"Cruise Planner URL must contain shipCode and sailDate: {url}")
    return {"ship": q["shipCode"], "sail_date": f"{sail[:4]}-{sail[4:6]}-{sail[6:8]}", "booking_id": q.get("bookingId", "")}


def sailing_of(cfg: dict) -> dict:
    """{"ship", "sail_date"} from PLANNER_URL env, config ship/sail_date, or a legacy planner URL."""
    env_url = os.environ.get("PLANNER_URL")
    if env_url:
        return {k: v for k, v in parse_planner_url(env_url).items() if k != "booking_id"}
    if cfg.get("ship") and cfg.get("sail_date"):
        sail = str(cfg["sail_date"]).replace("-", "")
        return {"ship": cfg["ship"], "sail_date": f"{sail[:4]}-{sail[4:6]}-{sail[6:8]}"}
    url = cfg.get("planner_url") or next(iter((cfg.get("pages") or {}).values()), "")
    if url:
        return {k: v for k, v in parse_planner_url(url).items() if k != "booking_id"}
    raise ValueError("No sailing configured. Paste a Cruise Planner URL in the dashboard Settings "
                     "(or set ship and sail_date in config.json).")


def _load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def _save_json(path: Path, payload) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def load_lowest() -> dict[str, float]:
    return _load_json(LOWEST_FILE, {})


def save_lowest(lowest: dict[str, float]) -> None:
    _save_json(LOWEST_FILE, lowest)


def load_categories() -> dict[str, str]:
    return _load_json(CATEGORIES_FILE, {})


def save_categories(names: dict[str, str]) -> None:
    _save_json(CATEGORIES_FILE, names)


def load_products() -> dict[str, dict]:
    return _load_json(PRODUCTS_FILE, {})


def save_products(meta: dict[str, dict]) -> None:
    merged = load_products()
    merged.update(meta)
    _save_json(PRODUCTS_FILE, merged)


def append_history(prices: dict[str, float], ts: datetime | None = None) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    ts = ts or datetime.now()
    with HISTORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": ts.isoformat(timespec="minutes"), "prices": prices}) + "\n")


def read_history() -> list[dict]:
    if not HISTORY_FILE.exists():
        return []
    rows = []
    for line in HISTORY_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def last_history() -> dict | None:
    """The most recent history row, read from the end of the file."""
    if not HISTORY_FILE.exists():
        return None
    with HISTORY_FILE.open("rb") as f:
        f.seek(0, 2)
        pos, buf = f.tell(), b""
        while pos > 0 and buf.count(b"\n") < 2:
            step = min(65536, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
    for line in reversed(buf.split(b"\n")):
        if line.strip():
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                break
    rows = read_history()  # fall back to a full read if the tail looked odd
    return rows[-1] if rows else None


def summarize_history(rows: list[dict]) -> dict[str, dict]:
    """
    Per product: latest price, the recorded price before it, the highest price seen,
    and the last time the price changed (with the price it changed from).
    """
    products: dict[str, dict] = {}
    for row in rows:
        for key, price in row["prices"].items():
            p = products.setdefault(key, {"latest": None, "prev": None, "latest_ts": None, "first_ts": row["ts"],
                                          "max": price, "changed_ts": None, "before_change": None})
            if p["latest"] is not None and price != p["latest"]:
                p["changed_ts"], p["before_change"] = row["ts"], p["latest"]
            p["prev"], p["latest"], p["latest_ts"] = p["latest"], price, row["ts"]
            p["max"] = max(p["max"], price)
    return products


def series_for(rows: list[dict], key: str) -> list[dict]:
    """Price points for one product, keeping only the checks where the price changed plus the latest check."""
    points = [{"ts": r["ts"], "price": r["prices"][key]} for r in rows if key in r["prices"]]
    kept = [pt for i, pt in enumerate(points) if i == 0 or pt["price"] != points[i - 1]["price"]]
    if points and kept[-1] is not points[-1]:
        kept.append(points[-1])
    return kept


def series_file(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16] + ".json"


def build_summary(rows: list[dict] | None = None) -> dict:
    """Everything the dashboard needs except per-product series (served by the local API or exported files)."""
    rows = read_history() if rows is None else rows
    products = summarize_history(rows)
    for key, low in load_lowest().items():
        products.setdefault(key, {"latest": None, "prev": None, "latest_ts": None, "first_ts": None,
                                  "max": None, "changed_ts": None, "before_change": None})["lowest"] = low
    meta = load_products()
    for key, p in products.items():
        p["path"] = (meta.get(key) or {}).get("path")
        p["file"] = series_file(key)
    cfg = load_config()
    try:
        sailing = sailing_of(cfg)
    except ValueError:
        sailing = None
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "checks": len(rows),
        "last_ts": rows[-1]["ts"] if rows else None,
        "sailing": sailing,
        "categories": load_categories(),
        "products": products,
        "config": public_config(cfg),
    }
