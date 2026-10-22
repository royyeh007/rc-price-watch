# Cruise Price Watch

Tracks the price of **every** add-on in your Royal Caribbean Cruise Planner
(shore excursions, dining, drink packages, spa, internet, Perfect Day CocoCay,
…), logs each check, and pushes a notification to your phone when a product you
chose to watch drops below what you paid or hits a new low. Royal Caribbean lets
you cancel and rebook a purchase at the lower price, so a drop is worth acting on.

Includes a dashboard (React) to browse all products, star the ones you want to
watch, enter what you paid, and see price history. Run it locally, or let
GitHub Actions do the checking and GitHub Pages host the dashboard (see below).

```
rc-price-watch/
├── Makefile              quick commands (see below)
├── config.json           sailing, categories, starred products, paid prices
├── .github/workflows/    GitHub Actions: check every 6 h, commit data, publish the dashboard
├── watcher/
│   ├── watch.py          the price checker (run on a schedule)
│   ├── server.py         local dashboard server + JSON API
│   ├── export.py         writes the static JSON the GitHub Pages dashboard reads
│   └── store.py          shared storage helpers
├── ui/                   React dashboard (prebuilt in ui/dist)
└── data/                 history, lowest prices, product ids, category names (committed by the workflow)
```

## Setup (one time, ~2 minutes)

Requires Python 3.10+ and `make` (built into macOS/Linux; on Windows use
Git Bash or run the commands from the Makefile by hand). No browser and no
Royal Caribbean login are needed: prices come from the same public API the
Cruise Planner page uses before you sign in.

```sh
make install     # creates .venv, installs deps, creates config.json
make check       # one price check right now (~15 s, all categories)
make serve       # dashboard at http://localhost:8765
```

In the dashboard:

1. **Settings → Sailing**: open any category of your Cruise Planner on
   royalcaribbean.com and paste the address bar. It looks like
   `https://www.royalcaribbean.com/account/cruise-planner/category/beverage?bookingId=…&shipCode=ST&sailDate=20270627`.
   The ship and sail date go into `config.json`. The booking number is only
   needed for the ↗ links into the Cruise Planner and is kept out of the
   repository: put it in `config.local.json` (gitignored) for local use, or in
   the `BOOKING_ID` repository secret for the GitHub Pages site. Leave
   **Categories** blank to fetch everything.
2. **Settings → ntfy topic**: install the free **ntfy** app on your phone, subscribe to a
   long random topic name (e.g. `rc-star-0627-k7q2x9`), and enter the same name here.
3. Click **Check now**. All products appear in **All products**; use the search
   box and category filter to find things. **Top price drops** ranks every
   product by how far it is below its highest recorded price. Product names and
   the ↗ links open the product's page in the Cruise Planner.
4. Click **☆** next to each product you care about. Starred products move to
   **Watching**, and only those can trigger notifications.
5. In **Watching**, enter what you paid for anything you already booked. You're
   then notified only when the price drops below that; products without a paid
   price notify on any drop.

## Check automatically every 6 hours

```sh
make schedule    # prints the exact cron line / Task Scheduler settings for your machine
```

The dashboard doesn't need to be running for checks to happen; it just reads the
same data files.

## How it works

- `watch.py` reads the ship, sail date and booking id from your Cruise Planner
  URL, asks Royal Caribbean's GraphQL API (`aws-prd.api.rccl.com`, the same
  `WebCategories` and `WebProductsByCategory` queries the web page sends) for
  every category and every product in it, and appends the current per-guest
  price of each product to `data/history.jsonl` (every product, every check,
  whether or not it is watched). Product ids and Cruise Planner links go to
  `data/products.json`. Categories are fetched four at a time; a full run is
  about 480 products in roughly 15 seconds.
- Notifications (via ntfy.sh) are sent only when a price goes down, and only for
  watched products: the ones starred in the dashboard, anything with a "you
  paid" price, or legacy text filters in `config.json` (`"watch": ["deluxe
  beverage"]` matches by substring). With a paid price, a product notifies when
  it first drops below that price and on any further drop; without one, it
  notifies on any drop since the previous check. Nothing else is pushed: no
  start-up message and no error pushes. Errors appear in the dashboard's "Last
  check output" and in `data/watch.log` when run from cron.
- The API needs the public client key that royalcaribbean.com ships in its own
  JavaScript. The key is built in; if Royal Caribbean rotates it, the watcher
  looks up the new one automatically and stores it as `appkey` in `config.json`.
- `make dry-run` fetches and prints the current prices without recording or
  notifying.

### config.json

| key | meaning |
|---|---|
| `ship`, `sail_date` | the sailing, e.g. `ST` and `2027-06-27` (set by pasting a Cruise Planner URL in Settings) |
| `categories` | category ids to fetch; empty = all (`beverage`, `shorex`, `cococay`, `dining`, `internet`, `key`, `roomdelivery`, `spa`, `onboardactivities`, `preandpost`, `celebrations`, `show`, `photoPackage`, `gifts`) |
| `watch` | product keys (`category:Product title`) that trigger alerts; set by starring in the dashboard |
| `booked` | product key → price you paid |
| `appkey` | optional override of the built-in API key |

Private values live in `config.local.json` (gitignored) for local use and in
repository secrets on GitHub:

| private value | locally (`config.local.json`) | on GitHub (Actions secret) |
|---|---|---|
| ntfy topic for phone pushes | `ntfy_topic` | `NTFY_TOPIC` |
| booking number, for ↗ links only | `booking_id` | `BOOKING_ID` (baked into the published site, not the repo) |

The catalog API itself doesn't need the booking number.

## Host it on GitHub (no computer needed)

The repository doubles as the database and GitHub does the work:

- **GitHub Actions** ([.github/workflows/check.yml](.github/workflows/check.yml))
  runs `watch.py` every 6 hours, commits the updated `data/` files, builds the
  dashboard with the exported JSON, and publishes it to **GitHub Pages**.
- The dashboard on Pages is static. It reads `data/summary.json`, and reads and
  writes `config.json` in the repository through the GitHub API so starring,
  paid prices and settings still work from the page. **Check now** starts the
  workflow.

Setup:

1. Push this folder to a GitHub repository (public, unless you have GitHub
   Pro, because Pages on the free plan needs a public repo).
2. In the repository: **Settings → Pages → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → New repository secret**:
   `NTFY_TOPIC` = your ntfy topic (anyone who knows the topic can push to your
   phone, so keep it out of `config.json`) and `BOOKING_ID` = your booking
   number (so the ↗ links work without typing it into each browser).
4. **Actions → Check prices and publish dashboard → Run workflow** once; the
   site appears at `https://<you>.github.io/<repo>/`.
5. On the site, open **Settings → This browser only** and enter a GitHub
   token so you can edit from the page. Make a fine-grained token at
   github.com → Settings → Developer settings → Personal access tokens, limited
   to this repository, with **Contents: read and write** and **Actions: read
   and write**. It stays in that browser's local storage.

What is public in a public repo: ship code, sail date, prices, and which
products you star or have paid prices for. Not the ntfy topic, not your login
(the watcher never signs in). The booking number is not in the repository
either, but with the `BOOKING_ID` secret set it is readable by anyone who
opens the published site's data file; skip that secret and enter it per
browser instead if you'd rather keep it fully private. GitHub disables
scheduled workflows in repos with no activity for 60 days; the workflow's own
commits count as activity. `make site` previews the static build locally.

## Troubleshooting

- **"no products returned for …"** — that category is empty for your sailing or
  the API changed. The raw response is saved in `data/debug/`.
- **"rejected the API key"** — the key rotated and the automatic lookup failed.
  Open the Cruise Planner in your browser, open DevTools → Network, click any
  `graphql` request and copy its `appkey` header into `config.json` as `"appkey"`.
- **Dashboard shows an error after updating** — restart `make serve` so the
  server picks up the new API.
- **GitHub Pages dashboard says read-only** — add a GitHub token under
  Settings → This browser only. **Check now does nothing** — the token needs
  *Actions: read and write*; see the run in the repository's Actions tab.
- **Edit the dashboard** — change files in `ui/src/`, then `make ui` (needs Node 18+).

## Why not drive the website in a browser?

An earlier version opened the Cruise Planner in a headless browser with a saved
login. Royal Caribbean's bot protection (Akamai) flags that browser session after
the first automated visit and then serves an "our site is on vacation" page to
every later visit, headless or not. The public API has no such problem and
needs no login, so the browser approach was dropped.
