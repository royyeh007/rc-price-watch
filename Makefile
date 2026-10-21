# Royal Caribbean Cruise Planner price watcher
#
#   make install   one-time setup (Python deps in .venv + config.json)
#   make check     run one price check now
#   make dry-run   fetch and print current prices without recording anything
#   make serve     start the dashboard at http://localhost:8765
#   make ui        rebuild the React dashboard (only needed if you edit ui/src)
#   make site      preview the static (GitHub Pages) build at http://localhost:8766
#   make schedule  print the cron / Task Scheduler line for every-6-hours checks

ROOT     := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
WATCHER  := $(ROOT)/watcher
VENV     := $(ROOT)/.venv
SYS_PY   ?= python3
# Use the project virtualenv once it exists, otherwise fall back to system python3.
PY       ?= $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,$(SYS_PY))

.PHONY: install check dry-run serve ui site schedule clean

install:
	@test -x $(VENV)/bin/python || $(SYS_PY) -m venv $(VENV)
	$(VENV)/bin/python -m pip install --upgrade pip
	$(VENV)/bin/python -m pip install -r $(ROOT)/requirements.txt
	@test -f $(ROOT)/config.json || cp $(ROOT)/config.example.json $(ROOT)/config.json
	@mkdir -p $(ROOT)/data
	@echo
	@echo "Installed. Next:  make check   then   make serve"

check:
	cd $(WATCHER) && $(PY) watch.py

dry-run:
	cd $(WATCHER) && $(PY) watch.py --dry-run

serve:
	cd $(WATCHER) && $(PY) server.py

ui:
	cd $(ROOT)/ui && npm install && npm run build

site: ui
	rm -rf $(ROOT)/site && cp -R $(ROOT)/ui/dist $(ROOT)/site
	cd $(WATCHER) && $(PY) export.py $(ROOT)/site
	@echo "Static preview (what GitHub Pages serves): http://localhost:8766   (Ctrl+C to stop)"
	cd $(ROOT)/site && $(PY) -m http.server 8766 --bind 127.0.0.1

schedule:
	@echo "Add this with 'crontab -e' (Mac/Linux) to check every 6 hours:"
	@echo
	@echo "  0 */6 * * * cd $(WATCHER) && $(PY) watch.py >> $(ROOT)/data/watch.log 2>&1"
	@echo
	@echo "Windows: Task Scheduler -> Create Basic Task -> Daily, repeat every 6 hours ->"
	@echo "  Program: python   Arguments: watch.py   Start in: $(WATCHER)"

clean:
	rm -rf $(ROOT)/data/debug $(ROOT)/site $(ROOT)/ui/node_modules $(VENV)
