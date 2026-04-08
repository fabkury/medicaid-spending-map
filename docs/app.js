(function () {
    "use strict";

    // ── State ──
    var codeIndex = null;       // { quarters: [...], codes: [...] }
    var countyInfo = null;      // { fips: { name, state, pop }, ... }
    var countyGeoJSON = null;
    var stateGeoJSON = null;
    var currentCodeData = null; // { fips: [val, val, ...], ... }
    var currentCode = null;
    var currentQuarterIdx = -1;
    var currentMaxVal = 1;
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
            if (currentCodeData && currentQuarterIdx >= 0) {
                var vals = currentCodeData[fips];
                var val = vals ? vals[currentQuarterIdx] : null;
                valueHTML =
                    '<div class="tooltip-value">' + formatCurrency(val) + '</div>' +
                    '<div class="tooltip-label">per capita &middot; pop. ' + pop + '</div>';
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
            html +=
                '<div class="dropdown-item' + (i === activeIdx ? " active" : "") + '" data-idx="' + i + '">' +
                '<div class="code">' + escapeHTML(c.code) + '</div>' +
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

    function selectCode(codeObj) {
        $dropdown.classList.add("hidden");
        $input.value = codeObj.code;
        currentCode = codeObj.code;

        $selected.innerHTML =
            '<span class="code-label">' + escapeHTML(codeObj.code) + '</span> &mdash; ' +
            escapeHTML(codeObj.desc || "No description") + '<br>' +
            '<small>' + formatClaims(codeObj.claims) + ' claims (' + codeObj.pct + '% of all)</small>';
        $selected.classList.remove("hidden");

        if ($quarterSelect.value === "") {
            $quarterSelect.value = codeIndex.quarters.length - 1;
            currentQuarterIdx = codeIndex.quarters.length - 1;
        }

        showLoading();
        fetchJSON(DATA_BASE + encodeURIComponent(currentCode) + ".json")
            .then(function (data) {
                currentCodeData = data;
                hideLoading();
                updateMap();
            })
            .catch(function (err) {
                console.error("Failed to load data for", currentCode, err);
                currentCodeData = null;
                hideLoading();
            });
    }

    // ── Update map via feature-state ──
    function updateMap() {
        if (!map || !map.getSource("counties")) return;
        if (!currentCodeData || currentQuarterIdx < 0) return;

        // Collect non-null positive values to determine scale
        var values = [];
        for (var fips in currentCodeData) {
            var v = currentCodeData[fips][currentQuarterIdx];
            if (v != null && v > 0) values.push(v);
        }

        if (values.length === 0) {
            clearAllStates();
            $legend.classList.add("hidden");
            return;
        }

        // 98th percentile as scale max (caps outliers)
        values.sort(function (a, b) { return a - b; });
        var p98 = values[Math.floor(values.length * 0.98)];
        currentMaxVal = Math.max(p98, 0.01);

        // Set feature-state "v" for each county (0-1 normalized)
        for (var i = 0; i < allFips.length; i++) {
            var f = allFips[i];
            var arr = currentCodeData[f];
            var val = arr ? arr[currentQuarterIdx] : null;

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
        $legendMin.textContent = "$0";
        $legendMax.textContent = formatCurrency(currentMaxVal);
    }

    function clearAllStates() {
        for (var i = 0; i < allFips.length; i++) {
            map.setFeatureState({ source: "counties", id: allFips[i] }, { v: null });
        }
    }

    // ── Boot ──
    initMap();
})();
