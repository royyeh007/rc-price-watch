#!/usr/bin/env python3
"""
Royal Caribbean Cruise Planner price watcher (API based: no browser, no login).

The Cruise Planner shows prices before you sign in, and the page loads them from
Royal Caribbean's public GraphQL endpoint. This script asks that endpoint for
every category of your sailing (shore excursions, dining, drinks, spa, ...),
records the price of every product, and pushes an ntfy.sh notification only
when the price of a product you selected in the dashboard goes down:
  * if you entered what you paid: when it first drops below that (and on any
    further drop), or
  * otherwise: on any drop since the previous check.
Nothing else is pushed to your phone.

Run:      python watch.py             (schedule this, e.g. every 6 hours, or let GitHub Actions do it)
Preview:  python watch.py --dry-run   (fetch and print prices; record nothing)
Test:     python watch.py --test-push (send a test notification to the phone)

Environment overrides (used by the GitHub Actions workflow so secrets stay out of config.json):
  NTFY_TOPIC    ntfy.sh topic to push to
  PLANNER_URL   a Cruise Planner URL to take the ship and sail date from
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import urljoin

import requests

from store import (DEBUG_DIR, append_history, last_history, load_config, load_lowest, sailing_of,
                   save_categories, save_config, save_lowest, save_products)

GRAPHQL_URL = "https://aws-prd.api.rccl.com/en/royal/web/graphql"
PLANNER_HOME = "https://www.royalcaribbean.com/account/cruise-planner/"
USER_AGENT = "rc-price-watch/1.0 (personal price tracker)"
WORKERS = 4          # categories fetched at a time
PAGE_SIZE = 24       # API maximum

# Public client key that royalcaribbean.com ships in its Cruise Planner JavaScript
# (APIGEE_APP_KEY_GQL). Every visitor's browser sends it. If Royal Caribbean rotates
# it, discover_appkey() finds the new one; you can also set "appkey" in config.json.
DEFAULT_APPKEY = "trL6t38bpvA5p65XlCrhFKzug8NNkqCD"

# Same queries the Cruise Planner page sends, trimmed to the fields we use.
CATEGORIES_QUERY = """
query WebCategories($shipCode: ShipCodeScalar!, $sailDate: LocalDateScalar!) {
  categories(shipCode: $shipCode, sailDate: $sailDate,
             filter: {limitCategoriesWithProducts: true, includeNonRevenueCategories: false, limitCategoriesWithVenues: false}) {
    ... on CategoryResultSuccess { categories { id name order } }
  }
}
"""
PRODUCTS_QUERY = """
query WebProductsByCategory($category: String!, $passengerId: String, $shipCode: ShipCodeScalar!,
                            $sailDate: LocalDateScalar!, $reservationId: String, $pageSize: Long,
                            $currentPage: Long, $sorting: Sorting, $filter: FilterInput, $currencyCode: String!) {
  products(category: $category, guestTypes: [ADULT], passengerId: $passengerId, shipCode: $shipCode,
           sailDate: $sailDate, reservationId: $reservationId, pageSize: $pageSize, currentPage: $currentPage,
           sorting: $sorting, filter: $filter, currencyIso: $currencyCode) {
    ... on CommerceProductResultSuccess {
      commerceProducts {
        id
        title
        price { currency promotionalPrice formattedPromotionalPrice formattedBasePrice salesUnit { label } }
      }
      pageInfo { totalResults totalPages hasNextPage }
    }
  }
}
"""
MONEY_RE = re.compile(r"[\d,]+(?:\.\d+)?")


def notify(topic: str, title: str, message: str, priority: str = "high") -> bool:
    """Push to the phone via ntfy.sh. Returns True when ntfy accepted the message."""
    if not topic or "CHANGE-ME" in topic:
        print("[warn] ntfy topic not set; skipping push", file=sys.stderr)
        return False
    try:
        r = requests.post(
            f"https://ntfy.sh/{topic}",
            data=message.encode("utf-8"),
            headers={"Title": title, "Priority": priority, "Tags": "ship,moneybag"},
            timeout=15,
        )
        r.raise_for_status()
        return True
    except requests.RequestException as e:
        print(f"[warn] ntfy push failed: {e}", file=sys.stderr)
        return False


# --------------------------------------------------------------------------- sailing

def product_path(category: str, product_id: str) -> str:
    """Path of the product's page in the Cruise Planner (the dashboard adds the booking id locally)."""
    return f"/account/cruise-planner/category/{category}/product/{product_id}"


def sailing_from_config(cfg: dict) -> dict:
    try:
        s = sailing_of(cfg)
    except ValueError as e:
        sys.exit(str(e))
    # reservationId is optional for the catalog, so the booking number never has to be stored.
    return {"shipCode": s["ship"], "sailDate": s["sail_date"], "reservationId": "",
            "currencyCode": cfg.get("currency") or "USD"}


# --------------------------------------------------------------------------- API

class AppKeyRejected(RuntimeError):
    pass


def new_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Content-Type": "application/json", "Accept": "application/json",
                      "Origin": "https://www.royalcaribbean.com", "Referer": "https://www.royalcaribbean.com/"})
    return s


def graphql(session: requests.Session, appkey: str, operation: str, query: str, variables: dict) -> dict:
    r = session.post(GRAPHQL_URL, headers={"AppKey": appkey}, timeout=30,
                     json={"operationName": operation, "variables": variables, "query": query})
    if r.status_code == 401:
        raise AppKeyRejected(r.text[:200])
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise RuntimeError(f"GraphQL error in {operation}: {json.dumps(body['errors'])[:300]}")
    return body.get("data") or {}


def list_categories(session: requests.Session, appkey: str, sailing: dict) -> list[dict]:
    """All Cruise Planner categories that have products for this sailing: [{id, name, order}]."""
    data = graphql(session, appkey, "WebCategories", CATEGORIES_QUERY,
                   {"shipCode": sailing["shipCode"], "sailDate": sailing["sailDate"]})
    cats = (data.get("categories") or {}).get("categories") or []
    return sorted(cats, key=lambda c: (c.get("order") or 0, c["id"]))


def _price_of(product: dict) -> float | None:
    for p in product.get("price") or []:
        for field in ("promotionalPrice", "formattedPromotionalPrice", "formattedBasePrice"):
            v = p.get(field)
            if isinstance(v, (int, float)) and v > 0:
                return float(v)
            if isinstance(v, str):
                m = MONEY_RE.search(v)
                if m:
                    return float(m.group(0).replace(",", ""))
    return None


def fetch_category(session: requests.Session, appkey: str, sailing: dict, category: str) -> dict[str, dict]:
    """Return {product title: {"price": current price, "id": product id}} for one category, following pagination."""
    found: dict[str, dict] = {}
    page = 0
    while True:
        variables = {
            "category": category, "shipCode": sailing["shipCode"], "sailDate": sailing["sailDate"],
            "reservationId": sailing["reservationId"], "currencyCode": sailing["currencyCode"],
            "passengerId": "", "pageSize": PAGE_SIZE, "currentPage": page,
            "sorting": {"sortKey": "RANK", "sortKeyOrder": "ASCENDING"},
            "filter": {"includeVariantProducts": False},
        }
        result = graphql(session, appkey, "WebProductsByCategory", PRODUCTS_QUERY, variables).get("products") or {}
        products = result.get("commerceProducts") or []
        if not products and page == 0:
            DEBUG_DIR.mkdir(parents=True, exist_ok=True)
            path = DEBUG_DIR / f"{category}-{datetime.now():%Y%m%d-%H%M%S}.json"
            path.write_text(json.dumps({"variables": variables, "result": result}, indent=1), encoding="utf-8")
            print(f"[warn] no products returned for '{category}'; saved data/debug/{path.name}", file=sys.stderr)
        for p in products:
            title, price = (p.get("title") or "").strip(), _price_of(p)
            if title and price and (title not in found or price < found[title]["price"]):
                found[title] = {"price": price, "id": str(p.get("id") or "")}
        if not (result.get("pageInfo") or {}).get("hasNextPage"):
            return found
        page += 1


def discover_appkey(session: requests.Session) -> str | None:
    """Find the current GraphQL AppKey in the Cruise Planner's JavaScript bundles."""
    try:
        html = session.get(PLANNER_HOME, timeout=30).text
    except requests.RequestException:
        return None
    base = re.search(r'<base[^>]+href="([^"]+)"', html)
    base_url = urljoin(PLANNER_HOME, base.group(1)) if base else PLANNER_HOME
    queue = [urljoin(base_url, s) for s in re.findall(r'<script[^>]+src="([^"]+)"', html)]
    seen: set[str] = set()
    while queue and len(seen) < 80:
        url = queue.pop(0)
        if url in seen or "royalcaribbean.com" not in url:
            continue
        seen.add(url)
        try:
            js = session.get(url, timeout=60).text
        except requests.RequestException:
            continue
        m = re.search(r'APIGEE_APP_KEY_GQL\s*:\s*"([A-Za-z0-9]+)"', js)
        if m:
            return m.group(1)
        queue.extend(urljoin(base_url, c) for c in set(re.findall(r'["\']((?:\./)?chunk-[A-Za-z0-9]+\.js)["\']', js)))
    return None


def fetch_all(cfg: dict) -> tuple[dict[str, float], dict[str, str]]:
    """
    Fetch every product of the configured sailing.
    Returns ({"<category id>:<product title>": price}, {category id: category name}).
    """
    session = new_session()
    appkey = cfg.get("appkey") or DEFAULT_APPKEY
    sailing = sailing_from_config(cfg)

    try:
        cats = list_categories(session, appkey, sailing)
    except AppKeyRejected:
        print("[info] API key rejected; looking up the current one on royalcaribbean.com", file=sys.stderr)
        new_key = discover_appkey(session)
        if not new_key or new_key == appkey:
            raise RuntimeError("Royal Caribbean rejected the API key and no new key was found. "
                               "See README troubleshooting.") from None
        appkey, cfg["appkey"] = new_key, new_key
        save_config(cfg)
        cats = list_categories(session, appkey, sailing)

    names = {c["id"]: c["name"] for c in cats}
    wanted = cfg.get("categories") or list(names)
    unknown = [c for c in wanted if c not in names]
    if unknown:
        print(f"[warn] ignoring unknown categories: {', '.join(unknown)} (available: {', '.join(names)})", file=sys.stderr)
    wanted = [c for c in wanted if c in names]
    if not wanted:
        raise RuntimeError("No categories to fetch.")

    def one(cid: str):
        try:
            return cid, fetch_category(new_session(), appkey, sailing, cid), None
        except Exception as e:  # noqa: BLE001 - one failing category shouldn't lose the others
            return cid, {}, e

    results: dict[str, float] = {}
    meta: dict[str, dict] = {}
    failures = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for cid, products, err in pool.map(one, wanted):
            if err:
                failures.append((cid, err))
                print(f"[warn] {cid}: {err}", file=sys.stderr)
            for title, info in products.items():
                key = f"{cid}:{title}"
                results[key] = info["price"]
                meta[key] = {"id": info["id"], "category": cid,
                             "path": product_path(cid, info["id"]) if info["id"] else None}
    if failures and len(failures) == len(wanted):
        raise RuntimeError(f"every category failed, e.g. {failures[0][0]}: {failures[0][1]}")
    save_categories({cid: names[cid] for cid in wanted})
    save_products(meta)
    return results, names


# --------------------------------------------------------------------------- alerts

def find_drops(current: dict[str, float], previous: dict[str, float], lowest: dict[str, float],
               watched, booked_price) -> list[str]:
    """
    One line per watched product whose price went down.
      * with a paid price: when it first goes below what you paid, and on every further drop;
      * without one: on any drop since the previous check.
    """
    alerts = []
    for key, price in current.items():
        if not watched(key):
            continue
        paid, before, low = booked_price(key), previous.get(key), lowest.get(key)
        if paid is not None:
            if price < paid and (before is None or before >= paid or price < before):
                alerts.append(f"{key}: ${price:.2f} — below what you paid (${paid:.2f}, save ${paid - price:.2f}). Rebook!")
        elif before is not None and price < before:
            tag = " — new low" if low is not None and price < low else ""
            alerts.append(f"{key}: ${before:.2f} → ${price:.2f} (−${before - price:.2f}){tag}")
    return alerts


# --------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="fetch and print prices without recording or notifying")
    ap.add_argument("--test-push", action="store_true", help="send a test notification to the phone and exit")
    args = ap.parse_args()

    cfg = load_config()
    topic = os.environ.get("NTFY_TOPIC") or cfg.get("ntfy_topic") or ""
    if args.test_push:
        if not topic or "CHANGE-ME" in topic:
            sys.exit("No ntfy topic configured (NTFY_TOPIC secret on GitHub, or ntfy_topic in config.local.json locally).")
        ok = notify(topic, "Cruise watcher test", "Notifications work. You'll get a push like this when a watched "
                    "product's price drops.", "default")
        print("test notification sent" if ok else "test notification FAILED (see warning above)")
        sys.exit(0 if ok else 1)
    current, names = fetch_all(cfg)
    per_category = Counter(k.split(":", 1)[0] for k in current)
    summary = f"{len(current)} products in {len(per_category)} categories"

    if args.dry_run:
        for cid, n in per_category.most_common():
            print(f"{names.get(cid, cid)} ({cid}): {n} products")
        for key, price in sorted(current.items()):
            print(f"  {key}: ${price:.2f}")
        return
    if not current:
        sys.exit("no prices returned; see data/debug")

    previous = (last_history() or {}).get("prices", {})
    append_history(current)
    lowest = load_lowest()

    # What to alert on: products ticked in the dashboard (exact keys), anything with a
    # booked price, plus legacy substring entries such as "deluxe beverage".
    watch = list(cfg.get("watch") or [])
    exact = set(watch)
    substrings = [w.lower() for w in watch if ":" not in w]
    booked = {k: float(v) for k, v in (cfg.get("booked") or {}).items() if v}

    def booked_price(key: str) -> float | None:
        if key in booked:
            return booked[key]
        k = key.lower()
        for name, price in booked.items():
            if ":" not in name and name.lower() in k:
                return price
        return None

    def watched(key: str) -> bool:
        return key in exact or booked_price(key) is not None or any(w in key.lower() for w in substrings)

    watching = [f"{key}: ${price:.2f}" for key, price in current.items() if watched(key)]
    alerts = find_drops(current, previous, lowest, watched, booked_price)
    if alerts:
        notify(topic, "Cruise price DROP", "\n".join(alerts))
        print("Alerts:\n  " + "\n  ".join(alerts))

    for key, price in current.items():
        lowest[key] = min(price, lowest.get(key, price))
    save_lowest(lowest)

    if not alerts:
        stamp = f"{datetime.now():%Y-%m-%d %H:%M}"
        if watching:
            print(f"{stamp}: no drops. {summary}. Watching {len(watching)}: " + ", ".join(w.replace(": ", "=") for w in watching))
        else:
            print(f"{stamp}: no drops. {summary}. Nothing selected to watch yet; tick products in the dashboard to get alerts.")


if __name__ == "__main__":
    main()
