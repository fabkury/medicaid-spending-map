(function () {
    "use strict";

    // ── State ──
    var codeIndex = null;       // { quarters: [...], codes: [...] }
    var countyInfo = null;      // { fips: { name, state, pop }, ... }
    var countyGeoJSON = null;
    var stateGeoJSON = null;
    var selectedCodes = [];     // [{ code, desc, claims, pct }, ...]
    var codeDataCache = {};     // { code: { fips: [val, ...], ... }, ... }
    var currentQuarterIdx = -1;
    var currentMaxVal = 1;
    var viewMode = "percapita"; // "percapita" or "total"
    var map = null;
    var allFips = [];

    var NO_DATA_COLOR = "#e8e8e8";
    var hoveredFips = null;

    // DOM refs
    var $input = document.getElementById("hcpcs-input");
    var $dropdown = document.getElementById("hcpcs-dropdown");
    var $selected = document.getElementById("hcpcs-selected");
    var $quarterSelect = document.getElementById("quarter-select");
    var $legend = document.getElementById("legend");
    var $legendGradient = document.getElementById("legend-gradient");
    var $legendMin = document.getElementById("legend-min");
    var $legendMax = document.getElementById("legend-max");
    var $tooltip = document.getElementById("tooltip");
    var $loading = document.getElementById("loading");
    var $noDataMsg = document.getElementById("no-data-msg");
    var $detail = document.getElementById("county-detail");
    var $detailBody = document.getElementById("county-detail-body");
    var $detailClose = document.getElementById("county-detail-close");
    var $exportBtn = document.getElementById("export-csv");

    var DATA_BASE = "data/";

    // ── Helpers ──
    function fetchJSON(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
            return r.json();
        });
    }

    function showLoading() { $loading.classList.remove("hidden"); }
    function hideLoading() { $loading.classList.add("hidden"); }

    function formatCurrency(val) {
        if (val == null) return "No data";
        if (val >= 1000) return "$" + val.toLocaleString("en-US", { maximumFractionDigits: 0 });
        if (val >= 0.01) return "$" + val.toFixed(2);
        if (val > 0) return "<$0.01";
        return "$0.00";
    }

    function formatClaims(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return String(n);
    }

    function escapeHTML(str) {
        var d = document.createElement("div");
        d.textContent = str;
        return d.innerHTML;
    }

    // ── Map ──
    function initMap() {
        map = new maplibregl.Map({
            container: "map",
            style: {
                version: 8,
                sources: {},
                layers: [{
                    id: "background",
                    type: "background",
                    paint: { "background-color": "#f8f9fa" }
                }]
            },
            center: [-97, 38],
            zoom: 4,
            minZoom: 2,
            maxZoom: 12,
            maxBounds: [[-180, 10], [-50, 75]]
        });

        map.addControl(new maplibregl.NavigationControl(), "bottom-right");
        map.on("load", onMapLoaded);
    }

    function onMapLoaded() {
        showLoading();

        Promise.all([
            fetchJSON(DATA_BASE + "index.json"),
            fetchJSON(DATA_BASE + "counties.json"),
            fetchJSON(DATA_BASE + "counties-10m.json")
        ]).then(function (results) {
            codeIndex = results[0];
            countyInfo = results[1];
            var topoData = results[2];

            countyGeoJSON = topojson.feature(topoData, topoData.objects.counties);
            stateGeoJSON = topojson.mesh(topoData, topoData.objects.states, function (a, b) { return a !== b; });

            for (var i = 0; i < countyGeoJSON.features.length; i++) {
                var f = countyGeoJSON.features[i];
                f.properties.fips = String(f.id).padStart(5, "0");
                allFips.push(f.properties.fips);
            }

            // Counties source — promoteId so feature-state works with fips strings
            map.addSource("counties", {
                type: "geojson",
                data: countyGeoJSON,
                promoteId: "fips"
            });

            // Fill layer: uses feature-state "v" (0-1 normalized value)
            // When "v" is null (no data), show gray; otherwise interpolate through blue palette
            map.addLayer({
                id: "county-fill",
                type: "fill",
                source: "counties",
                paint: {
                    "fill-color": [
                        "case",
                        ["!=", ["feature-state", "v"], null],
                        ["interpolate", ["linear"], ["feature-state", "v"],
                            0.0,  "#f7fbff",
                            0.15, "#d0e1f2",
                            0.30, "#94c4df",
                            0.45, "#4a98c9",
                            0.60, "#2070b4",
                            0.75, "#08519c",
                            0.90, "#08306b",
                            1.0,  "#041733"
                        ],
                        NO_DATA_COLOR
                    ],
                    "fill-opacity": 0.88
                }
            });

            // County borders
            map.addLayer({
                id: "county-border",
                type: "line",
                source: "counties",
                paint: {
                    "line-color": "#ccc",
                    "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.1, 7, 0.5, 10, 1]
                }
            });

            // State borders
            map.addSource("states", { type: "geojson", data: stateGeoJSON });
            map.addLayer({
                id: "state-border",
                type: "line",
                source: "states",
                paint: {
                    "line-color": "#666",
                    "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 7, 1.5, 10, 2]
                }
            });

            // Hover outline (driven by feature-state, not filter)
            map.addLayer({
                id: "county-hover",
                type: "line",
                source: "counties",
                paint: {
                    "line-color": "#1a1a2e",
                    "line-width": [
                        "case",
                        ["boolean", ["feature-state", "hover"], false],
                        2.5,
                        0
                    ]
                }
            });

            setupHover();
            setupCountyClick();
            populateQuarters();
            setupSearch();
            hideLoading();
        });
    }

    // ── Hover / Tooltip ──
    function setupHover() {
        map.on("mousemove", "county-fill", function (e) {
            if (!e.features || !e.features.length) return;
            map.getCanvas().style.cursor = "pointer";

            var fips = e.features[0].properties.fips;
            if (fips !== hoveredFips) {
                if (hoveredFips) {
                    map.setFeatureState({ source: "counties", id: hoveredFips }, { hover: false });
                }
                hoveredFips = fips;
                map.setFeatureState({ source: "counties", id: fips }, { hover: true });
            }

            var info = countyInfo[fips];
            var name = info ? info.name : "Unknown";
            var state = info ? info.state : "";
            var pop = info ? info.pop.toLocaleString() : "N/A";

            var valueHTML = "";
            if (selectedCodes.length > 0 && currentQuarterIdx >= 0) {
                var val = getDisplayValue(fips, currentQuarterIdx);
                var label = viewMode === "total" ? "total &middot; " + pop + " enrollees" : "per enrollee &middot; " + pop + " enrollees";
                valueHTML =
                    '<div class="tooltip-value">' + formatCurrency(val) + '</div>' +
                    '<div class="tooltip-label">' + label + '</div>';
            }

            $tooltip.innerHTML =
                '<div class="county-name">' + escapeHTML(name) + '</div>' +
                '<div class="county-state">' + escapeHTML(state) + '</div>' +
                valueHTML;
            $tooltip.classList.remove("hidden");

            var x = e.point.x + 14;
            var y = e.point.y + 14;
            var cw = map.getContainer().offsetWidth;
            var ch = map.getContainer().offsetHeight;
            var tw = $tooltip.offsetWidth;
            var th = $tooltip.offsetHeight;
            if (x + tw > cw - 10) x = e.point.x - tw - 10;
            if (y + th > ch - 10) y = e.point.y - th - 10;
            $tooltip.style.left = x + "px";
            $tooltip.style.top = y + "px";
        });

        map.on("mouseleave", "county-fill", function () {
            map.getCanvas().style.cursor = "";
            if (hoveredFips) {
                map.setFeatureState({ source: "counties", id: hoveredFips }, { hover: false });
                hoveredFips = null;
            }
            $tooltip.classList.add("hidden");
        });
    }

    // ── County detail card (click/tap) ──
    var detailFips = null;

    function setupCountyClick() {
        map.on("click", "county-fill", function (e) {
            if (!e.features || !e.features.length) return;
            var fips = e.features[0].properties.fips;
            showCountyDetail(fips);
        });

        $detailClose.addEventListener("click", function () {
            $detail.classList.add("hidden");
            detailFips = null;
        });
    }

    function showCountyDetail(fips) {
        detailFips = fips;
        var info = countyInfo[fips];
        var name = info ? info.name : "Unknown";
        var state = info ? info.state : "";
        var pop = info ? info.pop : 0;

        var tpop = info ? info.tpop : 0;

        var html =
            '<div class="detail-header">' +
            '<div class="detail-county">' + escapeHTML(name) + '</div>' +
            '<div class="detail-state">' + escapeHTML(state) + '</div>' +
            '<div class="detail-pop">Medicaid enrollment: ' + pop.toLocaleString() +
            ' &middot; Total population: ' + tpop.toLocaleString() + '</div>' +
            '</div>';

        if (selectedCodes.length > 0 && currentQuarterIdx >= 0) {
            var qLabel = formatQuarterLabel(codeIndex.quarters[currentQuarterIdx]);
            html += '<table class="detail-table"><thead><tr>' +
                '<th>Code</th><th>Description</th><th>Per enrollee</th><th>Total</th>' +
                '</tr></thead><tbody>';

            var grandPerCapita = 0;
            var grandTotal = 0;
            var hasAny = false;

            for (var i = 0; i < selectedCodes.length; i++) {
                var c = selectedCodes[i];
                var data = codeDataCache[c.code];
                var arr = data ? data[fips] : null;
                var val = arr ? arr[currentQuarterIdx] : null;
                var total = (val != null && pop > 0) ? val * pop : null;

                if (val != null) {
                    grandPerCapita += val;
                    grandTotal += total;
                    hasAny = true;
                }

                html +=
                    '<tr>' +
                    '<td class="code-col">' + escapeHTML(c.code) + '</td>' +
                    '<td class="desc-col">' + escapeHTML(c.desc || "No description") + '</td>' +
                    '<td>' + formatCurrency(val) + '</td>' +
                    '<td>' + (total != null ? formatCurrency(total) : "No data") + '</td>' +
                    '</tr>';
            }

            if (selectedCodes.length > 1 && hasAny) {
                html +=
                    '<tr class="total-row">' +
                    '<td colspan="2">Total (' + selectedCodes.length + ' codes)</td>' +
                    '<td>' + formatCurrency(grandPerCapita) + '</td>' +
                    '<td>' + formatCurrency(grandTotal) + '</td>' +
                    '</tr>';
            }

            html += '</tbody></table>';
        } else if (selectedCodes.length === 0) {
            html += '<div class="detail-no-data">Select an HCPCS code and quarter to see spending data.</div>';
        } else {
            html += '<div class="detail-no-data">Select a quarter to see spending data.</div>';
        }

        $detailBody.innerHTML = html;
        $detail.classList.remove("hidden");
    }

    // ── Quarter selector ──
    function populateQuarters() {
        var quarters = codeIndex.quarters;
        for (var i = quarters.length - 1; i >= 0; i--) {
            var opt = document.createElement("option");
            opt.value = i;
            opt.textContent = formatQuarterLabel(quarters[i]);
            $quarterSelect.appendChild(opt);
        }
        $quarterSelect.addEventListener("change", function () {
            var val = $quarterSelect.value;
            currentQuarterIdx = val === "" ? -1 : parseInt(val, 10);
            updateMap();
        });
    }

    function formatQuarterLabel(q) {
        var yr = q.slice(0, 4);
        var qn = q.slice(5);
        var mo = { "1": "Jan\u2013Mar", "2": "Apr\u2013Jun", "3": "Jul\u2013Sep", "4": "Oct\u2013Dec" };
        return "Q" + qn + " " + yr + " (" + mo[qn] + ")";
    }

    // ── HCPCS Search ──
    var activeIdx = -1;
    var filtered = [];

    function positionDropdown() {
        var rect = $input.getBoundingClientRect();
        $dropdown.style.left = rect.left + "px";
        $dropdown.style.top = rect.bottom + "px";
        $dropdown.style.width = rect.width + "px";
    }

    function setupSearch() {
        filtered = codeIndex.codes.slice();

        $input.addEventListener("input", onSearchInput);
        $input.addEventListener("focus", function () {
            onSearchInput();
            $dropdown.classList.remove("hidden");
        });
        $input.addEventListener("keydown", onSearchKey);
        document.addEventListener("click", function (e) {
            if (!$input.contains(e.target) && !$dropdown.contains(e.target))
                $dropdown.classList.add("hidden");
        });
    }

    function onSearchInput() {
        var q = $input.value.trim().toLowerCase();
        filtered = q === "" ? codeIndex.codes.slice() : codeIndex.codes.filter(function (c) {
            return c.code.toLowerCase().indexOf(q) >= 0 || c.desc.toLowerCase().indexOf(q) >= 0;
        });
        activeIdx = -1;
        renderDropdown();
        positionDropdown();
        $dropdown.classList.remove("hidden");
    }

    function onSearchKey(e) {
        var items = $dropdown.querySelectorAll(".dropdown-item[data-idx]");
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, items.length - 1);
            highlight(items);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            highlight(items);
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (activeIdx >= 0 && activeIdx < filtered.length) selectCode(filtered[activeIdx]);
        } else if (e.key === "Escape") {
            $dropdown.classList.add("hidden");
        }
    }

    function renderDropdown() {
        var max = 50;
        var items = filtered.slice(0, max);
        var html = "";
        for (var i = 0; i < items.length; i++) {
            var c = items[i];
            var sel = isCodeSelected(c.code);
            html +=
                '<div class="dropdown-item' + (i === activeIdx ? " active" : "") + (sel ? " selected" : "") + '" data-idx="' + i + '">' +
                '<div class="code">' + escapeHTML(c.code) + (sel ? ' <span class="check">&#10003;</span>' : '') + '</div>' +
                '<div class="desc">' + escapeHTML(c.desc || "No description") + '</div>' +
                '<div class="meta">' + formatClaims(c.claims) + ' claims (' + c.pct + '%)</div>' +
                '</div>';
        }
        if (filtered.length > max) {
            html += '<div style="padding:8px 12px;color:#999;text-align:center;font-size:12px;">' +
                (filtered.length - max) + ' more results\u2026</div>';
        }
        if (filtered.length === 0) {
            html = '<div style="padding:8px 12px;color:#999;text-align:center;">No matching codes</div>';
        }
        $dropdown.innerHTML = html;

        var dropEls = $dropdown.querySelectorAll(".dropdown-item[data-idx]");
        for (var j = 0; j < dropEls.length; j++) {
            (function (el) {
                el.addEventListener("click", function () {
                    selectCode(filtered[parseInt(el.dataset.idx, 10)]);
                });
            })(dropEls[j]);
        }
    }

    function highlight(items) {
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle("active", i === activeIdx);
        }
        if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: "nearest" });
    }

    function isCodeSelected(code) {
        for (var i = 0; i < selectedCodes.length; i++) {
            if (selectedCodes[i].code === code) return true;
        }
        return false;
    }

    function selectCode(codeObj) {
        $dropdown.classList.add("hidden");
        $input.value = "";

        if (isCodeSelected(codeObj.code)) return;
        selectedCodes.push(codeObj);
        renderSelectedCodes();

        if ($quarterSelect.value === "") {
            $quarterSelect.value = codeIndex.quarters.length - 1;
            currentQuarterIdx = codeIndex.quarters.length - 1;
        }

        if (codeDataCache[codeObj.code]) {
            updateMap();
            return;
        }

        showLoading();
        fetchJSON(DATA_BASE + encodeURIComponent(codeObj.code) + ".json")
            .then(function (data) {
                codeDataCache[codeObj.code] = data;
                hideLoading();
                updateMap();
            })
            .catch(function (err) {
                console.error("Failed to load data for", codeObj.code, err);
                hideLoading();
            });
    }

    function removeCode(code) {
        selectedCodes = selectedCodes.filter(function (c) { return c.code !== code; });
        delete codeDataCache[code];
        renderSelectedCodes();
        if (selectedCodes.length === 0) {
            clearAllStates();
            $legend.classList.add("hidden");
            $noDataMsg.classList.add("hidden");
            updateExportBtn();
        } else {
            updateMap();
        }
    }

    function renderSelectedCodes() {
        if (selectedCodes.length === 0) {
            $selected.classList.add("hidden");
            $selected.innerHTML = "";
            return;
        }
        var html = "";
        for (var i = 0; i < selectedCodes.length; i++) {
            var c = selectedCodes[i];
            html +=
                '<div class="code-chip">' +
                '<span class="code-chip-label">' + escapeHTML(c.code) + '</span>' +
                '<span class="code-chip-desc">' + escapeHTML(c.desc || "No description") + '</span>' +
                '<button class="code-chip-remove" data-code="' + escapeHTML(c.code) + '" aria-label="Remove">&times;</button>' +
                '</div>';
        }
        $selected.innerHTML = html;
        $selected.classList.remove("hidden");

        var btns = $selected.querySelectorAll(".code-chip-remove");
        for (var j = 0; j < btns.length; j++) {
            (function (btn) {
                btn.addEventListener("click", function () {
                    removeCode(btn.dataset.code);
                });
            })(btns[j]);
        }
    }

    function getMergedPerCapita(fips, quarterIdx) {
        var sum = null;
        for (var i = 0; i < selectedCodes.length; i++) {
            var data = codeDataCache[selectedCodes[i].code];
            if (!data) continue;
            var arr = data[fips];
            var val = arr ? arr[quarterIdx] : null;
            if (val != null) {
                sum = (sum || 0) + val;
            }
        }
        return sum;
    }

    function getDisplayValue(fips, quarterIdx) {
        var pc = getMergedPerCapita(fips, quarterIdx);
        if (pc == null) return null;
        if (viewMode === "total") {
            var info = countyInfo[fips];
            var pop = info ? info.pop : 0;
            return pc * pop;
        }
        return pc;
    }

    // ── Update map via feature-state ──
    function updateMap() {
        if (!map || !map.getSource("counties")) return;
        if (selectedCodes.length === 0 || currentQuarterIdx < 0) return;

        // Collect display values to determine scale
        var values = [];
        for (var i = 0; i < allFips.length; i++) {
            var v = getDisplayValue(allFips[i], currentQuarterIdx);
            if (v != null && v > 0) values.push(v);
        }

        if (values.length === 0) {
            clearAllStates();
            $legend.classList.add("hidden");
            $noDataMsg.classList.remove("hidden");
            $exportBtn.disabled = true;
            return;
        }

        $noDataMsg.classList.add("hidden");

        // 98th percentile as scale max (caps outliers)
        values.sort(function (a, b) { return a - b; });
        var p98 = values[Math.floor(values.length * 0.98)];
        currentMaxVal = Math.max(p98, 0.01);

        // Set feature-state "v" for each county (0-1 normalized)
        for (var i = 0; i < allFips.length; i++) {
            var f = allFips[i];
            var val = getDisplayValue(f, currentQuarterIdx);

            if (val != null && val >= 0) {
                var normalized = Math.min(val / currentMaxVal, 1.0);
                map.setFeatureState({ source: "counties", id: f }, { v: normalized });
            } else {
                map.setFeatureState({ source: "counties", id: f }, { v: null });
            }
        }

        // Update legend
        $legend.classList.remove("hidden");
        $legendGradient.style.background =
            "linear-gradient(to right, #f7fbff, #d0e1f2, #94c4df, #4a98c9, #2070b4, #08519c, #08306b, #041733)";
        var $legendTitle = document.querySelector(".legend-title");
        if ($legendTitle) $legendTitle.textContent = viewMode === "total" ? "Total spending (USD)" : "Per-enrollee spending (USD)";
        $legendMin.textContent = "$0";
        $legendMax.textContent = formatCurrency(currentMaxVal);

        if (detailFips) showCountyDetail(detailFips);
        updateExportBtn();
    }

    function clearAllStates() {
        for (var i = 0; i < allFips.length; i++) {
            map.setFeatureState({ source: "counties", id: allFips[i] }, { v: null });
        }
    }

    // ── Methodology overlay ──
    function setupMethodology() {
        var $overlay = document.getElementById("methodology-overlay");
        var $link = document.getElementById("methodology-link");
        var $close = document.getElementById("methodology-close");

        if (!$link || !$overlay || !$close) return;

        $link.addEventListener("click", function (e) {
            e.preventDefault();
            $overlay.classList.remove("hidden");
        });

        $close.addEventListener("click", function () {
            $overlay.classList.add("hidden");
        });

        $overlay.addEventListener("click", function (e) {
            if (e.target === $overlay) $overlay.classList.add("hidden");
        });

        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && !$overlay.classList.contains("hidden")) {
                $overlay.classList.add("hidden");
            }
        });
    }

    // ── View toggle ──
    function setupViewToggle() {
        var btns = document.querySelectorAll("#view-toggle .view-btn");
        for (var i = 0; i < btns.length; i++) {
            (function (btn) {
                btn.addEventListener("click", function () {
                    if (btn.dataset.mode === viewMode) return;
                    viewMode = btn.dataset.mode;
                    for (var j = 0; j < btns.length; j++) {
                        btns[j].classList.toggle("active", btns[j].dataset.mode === viewMode);
                    }
                    updateMap();
                });
            })(btns[i]);
        }
    }

    // ── Panel collapse ──
    function setupPanelToggle() {
        var $panel = document.getElementById("panel");
        var $toggle = document.getElementById("panel-toggle");
        if (!$panel || !$toggle) return;

        $toggle.addEventListener("click", function () {
            $panel.classList.toggle("collapsed");
        });
    }

    // ── CSV Export ──
    function hashCodesFNV(codes) {
        var str = codes.slice().sort().join(",");
        var hash = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
    }

    function updateExportBtn() {
        $exportBtn.disabled = !(selectedCodes.length > 0 && currentQuarterIdx >= 0);
    }

    function exportCSV() {
        if (selectedCodes.length === 0 || currentQuarterIdx < 0) return;

        var codes = selectedCodes.map(function (c) { return c.code; });
        var qi = currentQuarterIdx;
        var isTotal = viewMode === "total";
        var modeLabel = isTotal ? "total" : "per_enrollee";

        // Build rows: only counties with data for at least one selected code
        var rows = [];
        for (var i = 0; i < allFips.length; i++) {
            var fips = allFips[i];
            var info = countyInfo[fips];
            if (!info) continue;

            var hasAny = false;
            var codeVals = [];
            var total = 0;

            for (var j = 0; j < codes.length; j++) {
                var data = codeDataCache[codes[j]];
                var arr = data ? data[fips] : null;
                var pc = arr ? arr[qi] : null;
                var val = null;
                if (pc != null) {
                    val = isTotal ? Math.round(pc * info.pop * 100) / 100 : pc;
                    total = Math.round((total + val) * 100) / 100;
                    hasAny = true;
                }
                codeVals.push(val);
            }

            if (!hasAny) continue;

            rows.push({
                fips: fips,
                name: info.name,
                state: info.state,
                pop: info.pop,
                codeVals: codeVals,
                total: total
            });
        }

        // Assemble CSV
        var header = ["county_fips", "county_name", "state", "medicaid_enrollment"];
        for (var j = 0; j < codes.length; j++) {
            header.push(codes[j]);
        }
        if (codes.length > 1) header.push("total");

        var lines = [header.join(",")];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var line = [
                r.fips,
                '"' + r.name.replace(/"/g, '""') + '"',
                '"' + r.state.replace(/"/g, '""') + '"',
                r.pop
            ];
            for (var j = 0; j < r.codeVals.length; j++) {
                line.push(r.codeVals[j] != null ? r.codeVals[j] : "");
            }
            if (codes.length > 1) line.push(r.total);
            lines.push(line.join(","));
        }

        var csv = lines.join("\n");
        var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        var url = URL.createObjectURL(blob);

        var slug = codes.length === 1 ? codes[0] : hashCodesFNV(codes);
        var quarter = codeIndex.quarters[qi];
        var filename = "medicaid-spending-" + modeLabel + "-" + slug + "-" + quarter + ".csv";

        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function setupExport() {
        $exportBtn.addEventListener("click", exportCSV);
    }

    // ── Boot ──
    document.addEventListener("DOMContentLoaded", function () {
        setupMethodology();
        setupPanelToggle();
        setupViewToggle();
        setupExport();
    });
    initMap();
})();
