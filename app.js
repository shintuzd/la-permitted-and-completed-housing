// LA Housing Tracker: chart, map, and pipeline views over data/permits.json.
// All views share one `state`; changing a control calls render().

const START = new Date(2001, 0, 1);
const COFO_START = 20050101;      // CofO dates aren't recorded before 2005
const PIPELINE_START_YEAR = 2005;

const TYPES = [
    { key: "sfh", label: "Single-family", color: "#7b61c9" },
    { key: "plex", label: "Duplex–Fourplex", color: "#f2b705" },
    { key: "apt", label: "Apartments (5+)", color: "#d7263d" },
    { key: "adu", label: "ADU", color: "#2a9d8f" },
];
const STATUS = [
    { key: "C", label: "Completed", color: "#1f6fb5" },
    { key: "P", label: "In progress", color: "#8ecae6" },
    { key: "F", label: "Finaled, no CofO date", color: "#c9ced4" },
    { key: "S", label: "Stalled or abandoned", color: "#e76f51" },
];
const RATE_LABELS = { FEDFUNDS: "Federal funds rate", MORTGAGE30US: "30-year mortgage rate" };
const PARTY_COLORS = { D: "#5b8fd6", R: "#e06464" };
const PRESETS = [
    { key: "all", label: "All time" },
    { key: "ytd", label: "This year" },
    { key: "12m", label: "Last 12 months" },
    { key: "5y", label: "Last 5 years" },
    { key: "custom", label: "Custom dates" },
];

const state = {
    measure: "issue",     // "issue" (permitted) or "cofo" (completed)
    nb: -1,               // neighborhood index, -1 = citywide
    units: "gross",       // "gross" or "net"
    rate: "FEDFUNDS",
    grain: "quarter",     // "month", "quarter", or "year"
    hidden: new Set(),    // housing types hidden via the legend or map chips
    preset: "all",
    from: null,           // Date range shared by every chart and the map (null = open-ended)
    to: null,
};

let P, RATES, EVENTS, HOODS, map;
const fmt = d3.format(",");
const tooltip = document.getElementById("tooltip");

// --- Data prep ---------------------------------------------------------------------------------

function typeKey(n) {
    const a = Math.abs(n);
    return a >= 5 ? "apt" : a >= 2 ? "plex" : "sfh";
}
const dateNum = s => (s ? +s.replace(/-/g, "") : 0);
const day = s => new Date(`${s}T00:00:00`);   // date-only strings as local dates, not UTC
const ymd = d3.timeFormat("%Y-%m-%d");
const monthIndex = d => d.getFullYear() * 12 + d.getMonth();
const today = () => d3.timeDay.floor(new Date());

// permits.json stores one row per permit; turn it into column arrays
function toColumns(file) {
    const raw = { neighborhoods: file.neighborhoods, count: file.rows.length };
    file.columns.forEach((name, c) => (raw[name] = file.rows.map(r => r[c])));
    return raw;
}

function prepare(raw) {
    const n = raw.count;
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
        const issue = raw.issue[i], cofo = raw.cofo[i];
        const du = raw.du[i], adu = raw.adu[i] + raw.jadu[i];
        const comps = [];
        if (du) comps.push({ type: typeKey(du), units: du });
        if (adu) comps.push({ type: "adu", units: adu });
        rows[i] = {
            i, nb: raw.nb[i], status: raw.status[i], comps,
            issue, cofo, submit: raw.submit[i],
            iy: +issue.slice(0, 4), inum: dateNum(issue), imi: +issue.slice(0, 4) * 12 + +issue.slice(5, 7) - 1,
            cnum: dateNum(cofo), cmi: cofo ? +cofo.slice(0, 4) * 12 + +cofo.slice(5, 7) - 1 : 0,
            added: Math.max(du, 0) + Math.max(adu, 0),
        };
    }
    return rows;
}

// The date range every view uses: [from, to] as Dates, plus the same as YYYYMMDD numbers
function dateRange() {
    const from = state.from || START, to = state.to || today();
    return { from, to, fromNum: dateNum(ymd(from)), toNum: dateNum(ymd(to)) };
}

function applyPreset(key) {
    const t = today();
    state.preset = key;
    if (key === "all") [state.from, state.to] = [null, null];
    if (key === "ytd") [state.from, state.to] = [d3.timeYear.floor(t), t];
    // Start on a month/quarter boundary so the first period on the chart is complete
    if (key === "12m") [state.from, state.to] = [d3.timeMonth.offset(d3.timeMonth.floor(t), -11), t];
    if (key === "5y") [state.from, state.to] = [d3.timeMonth.every(3).offset(d3.timeMonth.every(3).floor(t), -19), t];
    autoGrain();
}

// Pick a sensible period for the range: monthly for short ranges, quarterly otherwise
function autoGrain() {
    const { from, to } = dateRange();
    const years = (to - from) / 3.156e10;
    state.grain = years <= 3 ? "month" : years <= 12 ? (state.grain === "year" ? "year" : "quarter") : state.grain === "month" ? "quarter" : state.grain;
}

function inScope(p) {
    if (state.nb >= 0 && p.nb !== state.nb) return false;
    if (state.measure === "cofo" && p.cnum < COFO_START) return false;
    const { fromNum, toNum } = dateRange();
    const d = state.measure === "issue" ? p.inum : p.cnum;
    return d >= fromNum && d <= toNum;
}
const monthOf = p => (state.measure === "issue" ? p.imi : p.cmi);
function countable(c) {
    return (state.units === "net" || c.units > 0) && !state.hidden.has(c.type);
}

// --- Aggregation -------------------------------------------------------------------------------

const GRAIN_MONTHS = { month: 1, quarter: 3, year: 12 };

function periods() {
    const { from, to } = dateRange();
    const step = GRAIN_MONTHS[state.grain];
    const interval = d3.timeMonth.every(step);
    return interval.range(interval.floor(from), d3.timeDay.offset(to, 1)).map(start => {
        const end = interval.offset(start, 1);
        // Plot each period at the middle of the part that falls inside the date range
        const visStart = start < from ? from : start, visEnd = end > d3.timeDay.offset(to, 1) ? d3.timeDay.offset(to, 1) : end;
        return { key: monthIndex(start), start, end, mid: new Date((+visStart + +visEnd) / 2), partial: end > d3.timeDay.offset(to, 1) || start < from };
    });
}

function series() {
    const ps = periods();
    const step = GRAIN_MONTHS[state.grain];
    const index = new Map(ps.map((p, i) => [p.key, i]));
    const rows = ps.map(p => Object.assign({ period: p, mid: p.mid }, Object.fromEntries(TYPES.map(c => [c.key, 0]))));
    for (const p of P) {
        if (!inScope(p)) continue;
        const mi = monthOf(p);
        const idx = index.get(mi - (((mi % step) + step) % step));
        if (idx === undefined) continue;
        for (const c of p.comps) if (countable(c)) rows[idx][c.type] += c.units;
    }
    return rows;
}

function totals() {
    const byType = Object.fromEntries(TYPES.map(t => [t.key, 0]));
    let permits = 0;
    for (const p of P) {
        if (!inScope(p)) continue;
        let counted = false;
        for (const c of p.comps) {
            if (countable(c)) {
                byType[c.type] += c.units;
                counted = true;
            }
        }
        if (counted) permits++;
    }
    return { byType, permits, total: d3.sum(Object.values(byType)) };
}

// --- Tooltip -----------------------------------------------------------------------------------

function showTip(html, event) {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const pad = 14, w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
}
const hideTip = () => (tooltip.hidden = true);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// --- Legend + stats ----------------------------------------------------------------------------

function renderLegend() {
    const el = document.getElementById("legend");
    el.innerHTML = "";
    for (const c of [...TYPES].reverse()) {
        const b = document.createElement("button");
        b.className = "legend__item";
        b.type = "button";
        b.setAttribute("aria-pressed", String(!state.hidden.has(c.key)));
        b.innerHTML = `<span class="legend__swatch" style="background:${c.color}"></span>${c.label}`;
        b.onclick = () => {
            toggleType(c.key);
        };
        el.appendChild(b);
    }
    if (state.rate) {
        const s = document.createElement("span");
        s.className = "legend__item";
        s.style.cursor = "default";
        s.innerHTML = `<span class="legend__line"></span>${RATE_LABELS[state.rate]} (right axis)`;
        el.appendChild(s);
    }
}

function renderStats() {
    const t = totals();
    const verb = state.measure === "issue" ? "permitted" : "completed";
    const where = state.nb >= 0 ? HOODS[state.nb] : "Los Angeles";
    const when = rangeLabel();
    const cards = [`<div class="stat"><div class="stat__value">${fmt(t.total)}</div><div class="stat__label">units ${verb} in ${esc(where)}, ${when}</div></div>`];
    for (const ty of [...TYPES].reverse()) {
        cards.push(`<div class="stat"><div class="stat__value">${fmt(t.byType[ty.key])}</div><div class="stat__label"><span class="stat__swatch" style="background:${ty.color}"></span>${ty.label}</div></div>`);
    }
    document.getElementById("stats").innerHTML = cards.join("");
}

function rangeLabel() {
    if (state.preset === "all") return state.measure === "issue" ? "since 2001" : "since 2005";
    if (state.preset === "ytd") return `in ${today().getFullYear()}`;
    if (state.preset === "12m") return "in the last 12 months";
    if (state.preset === "5y") return "in the last 5 years";
    const { from, to } = dateRange(), f = d3.timeFormat("%b %-d, %Y");
    return `from ${f(from)} to ${f(to)}`;
}

// --- Main chart --------------------------------------------------------------------------------

function renderChart() {
    const el = document.getElementById("chart");
    el.innerHTML = "";
    const width = el.clientWidth;
    if (width < 200) return;   // not laid out yet (e.g. hidden tab); the resize handler redraws
    const narrow = width < 640;
    const m = { top: 52, right: state.rate ? 46 : 12, bottom: 0, left: narrow ? 44 : 74 };
    const H = narrow ? 260 : 340;
    const rowH = 15, rowGap = 4, axisH = 26;
    const leaderOffices = ["Mayor", "Governor", "President"];
    const totalH = m.top + H + axisH + leaderOffices.length * (rowH + rowGap) + 6;
    const W = width - m.left - m.right;

    const svg = d3.select(el).append("svg").attr("width", width).attr("height", totalH);
    svg.append("defs").html(`<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#f6f7f8"/><line x1="0" y1="0" x2="0" y2="6" stroke="#dfe3e7" stroke-width="2"/></pattern>`);
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);

    const rows = series();
    const cats = TYPES.filter(c => !state.hidden.has(c.key));
    const stack = d3.stack().keys(cats.map(c => c.key)).offset(d3.stackOffsetDiverging)(rows);
    const { from, to } = dateRange();
    const end = d3.timeDay.offset(to, 1);
    const x = d3.scaleTime().domain([from, end]).range([0, W]);
    const inView = d => d >= from && d < end;
    svg.select("defs").append("clipPath").attr("id", "plot-clip").append("rect").attr("y", -m.top).attr("width", W).attr("height", H + m.top);
    const plot = g.append("g").attr("clip-path", "url(#plot-clip)");
    const yMin = d3.min(stack, s => d3.min(s, d => d[0])) || 0;
    const yMax = d3.max(stack, s => d3.max(s, d => d[1])) || 1;
    const y = d3.scaleLinear().domain([Math.min(0, yMin), yMax * 1.08]).nice().range([H, 0]);

    // Era bands (events with an end date) and the no-CofO-data period
    const bands = EVENTS.city.filter(e => e.end_date && day(e.end_date) > from && day(e.start_date) < end);
    plot.selectAll(".band").data(bands).join("rect").attr("class", "band")
        .attr("x", d => x(day(d.start_date))).attr("y", 0)
        .attr("width", d => Math.max(1, x(day(d.end_date)) - x(day(d.start_date)))).attr("height", H);
    plot.selectAll(".band-label").data(bands).join("text").attr("class", "band-label")
        .attr("x", d => Math.max(0, x(day(d.start_date))) + 4).attr("y", 12).text(d => d.event);
    if (state.measure === "cofo" && from < new Date(2005, 0, 1)) {
        const x5 = x(new Date(2005, 0, 1));
        plot.append("rect").attr("class", "band band--nodata").attr("width", x5).attr("height", H);
        plot.append("text").attr("class", "band-label").attr("x", x5 / 2).attr("y", H / 2).attr("text-anchor", "middle")
            .text(narrow || x5 < 150 ? "No CofO data" : "No CofO data before 2005");
    }

    // Grid + axes
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-W).tickFormat(""));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(narrow ? "~s" : ",")));
    drawTimeAxis(g, x, H, W, narrow);
    if (!narrow) {
        g.append("text").attr("class", "leader-row-label").attr("transform", `translate(${-m.left + 12},${H / 2}) rotate(-90)`)
            .attr("text-anchor", "middle").text(state.units === "net" ? "Net units" : "Units");
    }

    // Stacked areas
    const area = d3.area().x(d => x(d.data.mid)).y0(d => y(d[0])).y1(d => y(d[1])).curve(d3.curveMonotoneX);
    const color = Object.fromEntries(TYPES.map(c => [c.key, c.color]));
    plot.append("g").selectAll("path").data(stack).join("path")
        .attr("fill", d => color[d.key]).attr("fill-opacity", 0.92).attr("d", area);
    if (yMin < 0) g.append("line").attr("x2", W).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#555");

    // The current period isn't over yet, so shade it as partial
    const last = rows[rows.length - 1].period;
    if (last.end > d3.timeDay.offset(today(), 1) && +to === +today()) {
        const xs = x(last.start);
        g.append("rect").attr("x", xs).attr("width", Math.max(0, W - xs)).attr("height", H).attr("fill", "url(#hatch)").attr("opacity", 0.7);
        if (!narrow) g.append("text").attr("class", "band-label").attr("x", W - 3).attr("y", H - 6).attr("text-anchor", "end").text("Partial");
    }

    // Interest rate (right axis)
    let rateByMonth = null;
    if (state.rate) {
        const pts = RATES[state.rate].map(([mo, v]) => ({ date: new Date(+mo.slice(0, 4), +mo.slice(5, 7) - 1, 15), v }));
        rateByMonth = new Map(RATES[state.rate]);
        const y2 = d3.scaleLinear().domain([0, d3.max(pts, d => d.v) * 1.1]).range([H, 0]);
        plot.append("path").datum(pts).attr("class", "rate-line").attr("d", d3.line().x(d => x(d.date)).y(d => y2(d.v)));
        g.append("g").attr("class", "axis").attr("transform", `translate(${W},0)`)
            .call(d3.axisRight(y2).ticks(5).tickFormat(d => `${d}%`));
    }

    // Point events (city), plus neighborhood events when a neighborhood is selected
    const points = EVENTS.city.filter(e => !e.end_date && inView(day(e.start_date))).map(e => ({ ...e, hood: false }));
    if (state.nb >= 0) {
        EVENTS.neighborhood.filter(e => e.neighborhood === HOODS[state.nb] && inView(day(e.start_date)))
            .forEach(e => points.push({ ...e, hood: true }));
    }
    const ev = g.append("g").selectAll("g").data(points).join("g")
        .attr("transform", d => `translate(${x(day(d.start_date))},0)`);
    ev.append("line").attr("class", "event-line").attr("y1", d => (d.hood ? -34 : -18)).attr("y2", H);
    ev.append("circle").attr("class", d => `event-dot${d.hood ? " event-dot--hood" : ""}`)
        .attr("cy", d => (d.hood ? -34 : -18)).attr("r", 5)
        .on("mousemove", (e, d) => showTip(`<h4>${esc(d.event)}</h4><div>${d3.timeFormat("%B %-d, %Y")(day(d.start_date))}${d.hood ? ` · ${esc(d.neighborhood)}` : ""}</div>${d.description ? `<div style="margin-top:4px">${esc(d.description)}</div>` : ""}`, e))
        .on("mouseleave", hideTip);

    // Leaders: Mayor / Governor / President by term, colored by party
    const lg = g.append("g").attr("transform", `translate(0,${H + axisH})`);
    leaderOffices.forEach((office, r) => {
        const row = lg.append("g").attr("transform", `translate(0,${r * (rowH + rowGap)})`);
        row.append("text").attr("class", "leader-row-label").attr("x", -6).attr("y", rowH - 4).attr("text-anchor", "end")
            .text(narrow ? office.slice(0, 3) : office);
        const terms = EVENTS.leaders.filter(l => l.office === office).map(l => ({
            ...l, x0: x(new Date(Math.max(+day(l.start), +from))), x1: x(l.end ? new Date(Math.min(+day(l.end), +end)) : end),
        })).filter(l => l.x1 > l.x0);
        const t = row.selectAll("g").data(terms).join("g");
        t.append("rect").attr("x", d => d.x0 + 0.5).attr("width", d => Math.max(0, d.x1 - d.x0 - 1)).attr("height", rowH)
            .attr("rx", 2).attr("fill", d => PARTY_COLORS[d.party] || "#999")
            .on("mousemove", (e, d) => showTip(`<h4>${esc(d.name)}</h4><div>${office} · ${d.party === "D" ? "Democrat" : d.party === "R" ? "Republican" : esc(d.party)}</div><div>${d3.timeFormat("%b %Y")(day(d.start))} – ${d.end ? d3.timeFormat("%b %Y")(day(d.end)) : "present"}</div>`, e))
            .on("mouseleave", hideTip);
        t.append("text").attr("class", "leader-label").attr("x", d => d.x0 + 5).attr("y", rowH - 4)
            .text(d => d.name.split(" ").slice(-1)[0])
            .each(function (d) { if (this.getComputedTextLength() > d.x1 - d.x0 - 8) this.remove(); });
    });

    // Brush (time range) + hover readout on the same layer
    const hover = g.append("line").attr("class", "hover-line").attr("y1", 0).attr("y2", H).style("display", "none");
    const brush = d3.brushX().extent([[0, 0], [W, H]]).on("end", ({ selection, sourceEvent }) => {
        if (!sourceEvent || !selection || selection[1] - selection[0] < 8) return;
        // Snap to whole periods so the zoomed chart doesn't start or end on a partial period
        const [a, b] = selection.map(x.invert);
        const interval = d3.timeMonth.every(GRAIN_MONTHS[state.grain]);
        state.preset = "custom";
        state.from = interval.floor(a);
        const end = d3.timeDay.offset(interval.ceil(b), -1);
        state.to = end > today() ? today() : end;
        autoGrain();
        render();
    });
    const bg = g.append("g").attr("class", "brush").call(brush);
    bg.selectAll(".overlay, .selection")
        .on("mousemove.tip", e => {
            const [mx] = d3.pointer(e, g.node());
            const i = d3.bisector(d => d.period.end).left(rows, x.invert(mx));
            const d = rows[Math.min(i, rows.length - 1)];
            hover.style("display", null).attr("x1", x(d.mid)).attr("x2", x(d.mid));
            const ps = d.period.start;
            const label = (state.grain === "year" ? ps.getFullYear()
                : state.grain === "quarter" ? `Q${Math.floor(ps.getMonth() / 3) + 1} ${ps.getFullYear()}`
                : d3.timeFormat("%B %Y")(ps)) + (d.period.partial ? " (partial)" : "");
            const lines = [...cats].reverse().map(c => `<tr><td><span class="stat__swatch" style="background:${c.color}"></span>${c.label}</td><td>${fmt(d[c.key])}</td></tr>`);
            const total = d3.sum(cats, c => d[c.key]);
            let rate = "";
            if (rateByMonth) {
                const months = d3.timeMonths(d.period.start, d.period.end).map(dt => d3.timeFormat("%Y-%m")(dt));
                const vals = months.map(mo => rateByMonth.get(mo)).filter(v => v != null);
                if (vals.length) rate = `<tr><td>${RATE_LABELS[state.rate]}</td><td>${d3.mean(vals).toFixed(2)}%</td></tr>`;
            }
            showTip(`<h4>${label}</h4><table>${lines.join("")}<tr><td><strong>Total</strong></td><td><strong>${fmt(total)}</strong></td></tr>${rate}</table>`, e);
        })
        .on("mouseleave.tip", () => { hover.style("display", "none"); hideTip(); });
}

// X axis with tick marks at period boundaries and labels centered on each period,
// so labels line up with the values plotted at each period's midpoint
function drawTimeAxis(g, x, H, W, narrow) {
    const [d0, d1] = x.domain();
    const years = (d1 - d0) / 3.156e10;
    let interval, label, every = 1;
    if (years > 3) {
        interval = d3.timeYear;
        label = d3.timeFormat("%Y");
        every = years > 14 ? (narrow ? 5 : 2) : narrow && years > 7 ? 2 : 1;
    } else if (years > 1.25) {
        interval = d3.timeMonth.every(3);
        label = d => `Q${Math.floor(d.getMonth() / 3) + 1}${d.getMonth() === 0 || narrow ? ` ${d.getFullYear()}` : ""}`;
        every = narrow ? 2 : 1;
    } else {
        interval = d3.timeMonth;
        label = d => d3.timeFormat(d.getMonth() === 0 ? "%b %Y" : "%b")(d);
        every = narrow || years > 0.75 ? 2 : 1;
    }
    const axis = g.append("g").attr("class", "axis").attr("transform", `translate(0,${H})`);
    axis.append("path").attr("d", `M0,0H${W}`);
    const starts = interval.range(interval.floor(d0), d1);
    starts.forEach((start, i) => {
        const end = interval.offset(start, 1);
        if (start >= d0) axis.append("line").attr("x1", x(start)).attr("x2", x(start)).attr("y2", 5);
        const a = Math.max(x(start), 0), b = Math.min(x(end), W);
        const n = interval === d3.timeYear ? start.getFullYear() : i;
        if (n % every || (b - a) * every < 26) return;   // room for the label across its stride
        axis.append("text").attr("x", (a + b) / 2).attr("y", 17).attr("text-anchor", "middle").text(label(start));
    });
}

function renderHoodEvents() {
    const el = document.getElementById("hood-events");
    const list = state.nb >= 0 ? EVENTS.neighborhood.filter(e => e.neighborhood === HOODS[state.nb]) : [];
    el.hidden = !list.length;
    el.innerHTML = list.length
        ? `<strong>Events in ${esc(HOODS[state.nb])}</strong><ul>${list.map(e => `<li>${d3.timeFormat("%b %Y")(day(e.start_date))}: ${esc(e.event)}${e.description ? `. ${esc(e.description)}` : ""}</li>`).join("")}</ul>`
        : "";
}

// --- Pipeline + durations ----------------------------------------------------------------------

function pipelineRows() {
    const { from, to } = dateRange();
    const years = d3.range(Math.max(PIPELINE_START_YEAR, from.getFullYear()), Math.max(PIPELINE_START_YEAR, to.getFullYear()) + 1);
    const out = new Map(years.map(y => [y, { year: y, C: 0, P: 0, F: 0, S: 0, toIssue: [], toCofo: [] }]));
    for (const p of P) {
        if (state.nb >= 0 && p.nb !== state.nb) continue;
        const row = out.get(p.iy);
        if (!row) continue;
        let units = 0;
        for (const c of p.comps) if (c.units > 0 && !state.hidden.has(c.type)) units += c.units;
        if (!units) continue;
        row[p.status] += units;
        if (p.submit && p.submit <= p.issue) row.toIssue.push((new Date(p.issue) - new Date(p.submit)) / 2.63e9);
        if (p.cofo && p.cofo >= p.issue) row.toCofo.push((new Date(p.cofo) - new Date(p.issue)) / 2.63e9);
    }
    return [...out.values()];
}

function staticLegend(id, items) {
    document.getElementById(id).innerHTML = items.map(i => i.line
        ? `<span class="legend__item" style="cursor:default"><span class="legend__line${i.dashed ? " legend__line--dashed" : ""}" style="border-color:${i.color}"></span>${i.label}</span>`
        : `<span class="legend__item" style="cursor:default"><span class="legend__swatch" style="background:${i.color}"></span>${i.label}</span>`).join("");
}

function renderPipeline(rows) {
    staticLegend("pipeline-legend", STATUS);
    const el = document.getElementById("pipeline");
    el.innerHTML = "";
    const width = el.clientWidth, m = { top: 8, right: 12, bottom: 26, left: 44 }, H = 220;
    if (width < 200) return;
    const W = width - m.left - m.right;
    const g = d3.select(el).append("svg").attr("width", width).attr("height", H + m.top + m.bottom)
        .append("g").attr("transform", `translate(${m.left},${m.top})`);
    const x = d3.scaleBand().domain(rows.map(r => r.year)).range([0, W]).padding(0.18);
    const y = d3.scaleLinear().domain([0, 1]).range([H, 0]);
    const keys = STATUS.map(s => s.key);
    const share = rows.map(r => {
        const t = d3.sum(keys, k => r[k]) || 1;
        return Object.assign({ year: r.year, total: d3.sum(keys, k => r[k]) }, Object.fromEntries(keys.map(k => [k, r[k] / t])));
    });
    const stack = d3.stack().keys(keys)(share);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${H})`)
        .call(d3.axisBottom(x).tickValues(rows.map(r => r.year).filter(yr => width > 640 || yr % 3 === 0)));
    g.selectAll(".s").data(stack).join("g").attr("fill", d => STATUS.find(s => s.key === d.key).color)
        .selectAll("rect").data(d => d).join("rect")
        .attr("x", d => x(d.data.year)).attr("width", x.bandwidth())
        .attr("y", d => y(d[1])).attr("height", d => Math.max(0, y(d[0]) - y(d[1])))
        .on("mousemove", (e, d) => {
            const r = rows.find(r => r.year === d.data.year);
            showTip(`<h4>Permitted in ${r.year}: ${fmt(d.data.total)} units</h4><table>${STATUS.map(s => `<tr><td><span class="stat__swatch" style="background:${s.color}"></span>${s.label}</td><td>${fmt(r[s.key])} (${d3.format(".0%")(d.data[s.key] || 0)})</td></tr>`).join("")}</table>`, e);
        })
        .on("mouseleave", hideTip);
}

function renderDurations(rows) {
    const recent = new Date().getFullYear() - 4;
    staticLegend("duration-legend", [
        { line: true, color: "#f2b705", label: "Submitted → permit issued" },
        { line: true, color: "#1f6fb5", label: "Permit issued → CofO" },
        { line: true, dashed: true, color: "#1f6fb5", label: "Still being finished (incomplete)" },
    ]);
    const el = document.getElementById("durations");
    el.innerHTML = "";
    const width = el.clientWidth, m = { top: 10, right: 12, bottom: 26, left: 44 }, H = 220;
    if (width < 200) return;
    const W = width - m.left - m.right;
    const g = d3.select(el).append("svg").attr("width", width).attr("height", H + m.top + m.bottom)
        .append("g").attr("transform", `translate(${m.left},${m.top})`);
    const data = rows.map(r => ({ year: r.year, toIssue: d3.median(r.toIssue), toCofo: d3.median(r.toCofo), nI: r.toIssue.length, nC: r.toCofo.length }));
    const [y0, y1] = d3.extent(data, d => d.year);
    const x = d3.scaleLinear().domain(y0 === y1 ? [y0 - 0.5, y1 + 0.5] : [y0, y1]).range([0, W]);
    const y = d3.scaleLinear().domain([0, (d3.max(data, d => Math.max(d.toIssue || 0, d.toCofo || 0)) || 12) * 1.1]).nice().range([H, 0]);
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-W).tickFormat(""));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d} mo`));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${H})`)
        .call(d3.axisBottom(x).tickValues(data.map(d => d.year).filter((yr, i, a) => a.length <= (width > 640 ? 22 : 8) || yr % 2 === 0)).tickFormat(d3.format("d")));
    const line = key => d3.line().defined(d => d[key] != null).x(d => x(d.year)).y(d => y(d[key]));
    g.append("path").datum(data).attr("fill", "none").attr("stroke", "#f2b705").attr("stroke-width", 2).attr("d", line("toIssue"));
    g.append("path").datum(data.filter(d => d.year <= recent)).attr("fill", "none").attr("stroke", "#1f6fb5").attr("stroke-width", 2).attr("d", line("toCofo"));
    g.append("path").datum(data.filter(d => d.year >= recent)).attr("fill", "none").attr("stroke", "#1f6fb5").attr("stroke-width", 2).attr("stroke-dasharray", "4 4").attr("d", line("toCofo"));
    for (const [key, c] of [["toIssue", "#f2b705"], ["toCofo", "#1f6fb5"]]) {
        g.selectAll(null).data(data.filter(d => d[key] != null)).join("circle")
            .attr("cx", d => x(d.year)).attr("cy", d => y(d[key])).attr("r", 2.5).attr("fill", c);
    }
    const hover = g.append("line").attr("class", "hover-line").attr("y1", 0).attr("y2", H).style("display", "none");
    g.append("rect").attr("width", W).attr("height", H).attr("fill", "transparent")
        .on("mousemove", e => {
            const yr = Math.round(x.invert(d3.pointer(e)[0]));
            const d = data.find(d => d.year === yr);
            if (!d) return;
            hover.style("display", null).attr("x1", x(yr)).attr("x2", x(yr));
            const f = v => (v == null ? "–" : `${v.toFixed(1)} months`);
            showTip(`<h4>Permits issued in ${yr}</h4><table><tr><td>Submitted → issued</td><td>${f(d.toIssue)}</td></tr><tr><td>Issued → CofO</td><td>${f(d.toCofo)}</td></tr><tr><td>Completed projects</td><td>${fmt(d.nC)}</td></tr></table>`, e);
        })
        .on("mouseleave", () => { hover.style("display", "none"); hideTip(); });
}

// --- Map ---------------------------------------------------------------------------------------

function buildFeatures(raw) {
    const features = [];
    for (const p of P) {
        const lat = raw.lat[p.i], lon = raw.lon[p.i];
        if (lat == null || lon == null || p.added <= 0) continue;
        const main = p.comps.find(c => c.units > 0 && c.type !== "adu") || p.comps.find(c => c.units > 0);
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: {
                i: p.i, u: p.added, n: p.nb, is: p.inum, cs: p.cnum,
                t: TYPES.findIndex(t => t.key === main.type),
            },
        });
    }
    return { type: "FeatureCollection", features };
}

function initMap(raw, hoods) {
    map = new maplibregl.Map({
        container: "map",
        style: "https://tiles.openfreemap.org/styles/positron",
        center: [-118.41, 34.03],
        zoom: 9.4,
        cooperativeGestures: false,
        attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.scrollZoom.disable();       // the page scrolls past the map; pinch/ctrl+scroll still zoom
    map.on("wheel", e => { if (e.originalEvent.ctrlKey) map.scrollZoom.enable(); });
    map.getCanvas().addEventListener("mouseleave", () => map.scrollZoom.disable());

    // Add layers once the basemap style is parsed; "load" also waits for every tile and can stall
    map.once("style.load", () => {
        hoods.features.forEach((f, idx) => (f.id = idx));
        map.addSource("hoods", { type: "geojson", data: hoods });
        map.addLayer({ id: "hood-fill", type: "fill", source: "hoods", paint: { "fill-color": "#0077ff", "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.06, 0] } });
        map.addLayer({ id: "hood-line", type: "line", source: "hoods", paint: { "line-color": "#9aa3ad", "line-width": 0.6 } });
        map.addLayer({ id: "hood-selected", type: "line", source: "hoods", filter: ["==", ["id"], -1], paint: { "line-color": "#0077ff", "line-width": 2.5 } });

        map.addSource("permits", { type: "geojson", data: buildFeatures(raw) });
        map.addLayer({
            id: "permits", type: "circle", source: "permits",
            layout: { "circle-sort-key": ["-", 0, ["get", "u"]] },
            paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"],
                    9, ["+", 1.2, ["*", 0.55, ["sqrt", ["get", "u"]]]],
                    12, ["+", 2, ["*", 0.95, ["sqrt", ["get", "u"]]]],
                    15, ["+", 3, ["*", 1.8, ["sqrt", ["get", "u"]]]]],
                "circle-opacity": dotOpacity(),
                "circle-stroke-color": "#fff",
                "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 0, 12, 0.6],
            },
        });

        // Citywide view: one circle per neighborhood sized by total units; fades out as you zoom in
        map.addSource("hood-agg", { type: "geojson", data: aggregateByNeighborhood() });
        map.addLayer({
            id: "agg-circles", type: "circle", source: "hood-agg",
            layout: { "circle-sort-key": ["-", 0, ["get", "units"]] },
            paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, ["get", "r"], 11.5, ["*", 1.6, ["get", "r"]]],
                "circle-color": "#0077ff",
                "circle-opacity": ["interpolate", ["linear"], ["zoom"], AGG_FADE[0], 0.55, AGG_FADE[1], 0],
                "circle-stroke-color": "#fff",
                "circle-stroke-width": 1,
                "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], AGG_FADE[0], 1, AGG_FADE[1], 0],
            },
        });
        map.addLayer({
            id: "agg-labels", type: "symbol", source: "hood-agg", maxzoom: AGG_FADE[1],
            filter: [">=", ["get", "r"], 11],
            layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-allow-overlap": false },
            paint: { "text-color": "#fff", "text-halo-color": "rgba(0,60,140,0.6)", "text-halo-width": 1 },
        });
        map.on("mousemove", "agg-circles", e => {
            if (map.getZoom() >= AGG_FADE[1] || state.nb >= 0) return hideTip();
            const f = e.features[0].properties;
            const verb = state.measure === "issue" ? "permitted" : "completed";
            showTip(`<h4>${esc(f.name)}</h4><div>${fmt(f.units)} units ${verb}, ${rangeLabel()}</div><table>${[...TYPES].reverse().map(t => `<tr><td><span class="stat__swatch" style="background:${t.color}"></span>${t.label}</td><td>${fmt(f[t.key])}</td></tr>`).join("")}</table><div style="margin-top:4px;color:#666">Click to see its projects</div>`, e.originalEvent);
        });
        map.on("mouseleave", "agg-circles", hideTip);
        map.on("zoom", updateMapLegend);

        let hovered = null;
        map.on("mousemove", "hood-fill", e => {
            if (hovered !== null) map.setFeatureState({ source: "hoods", id: hovered }, { hover: false });
            hovered = e.features[0].id;
            map.setFeatureState({ source: "hoods", id: hovered }, { hover: true });
        });
        map.on("mouseleave", "hood-fill", () => {
            if (hovered !== null) map.setFeatureState({ source: "hoods", id: hovered }, { hover: false });
            hovered = null;
        });
        map.on("click", e => {
            if (state.nb < 0 && map.getZoom() < AGG_FADE[1]) {
                const agg = map.queryRenderedFeatures(e.point, { layers: ["agg-circles"] });
                if (agg.length) { hideTip(); return setNeighborhood(agg[0].properties.id); }
            }
            const hit = map.queryRenderedFeatures(e.point, { layers: ["permits"] });
            if (hit.length) return showPermitPopup(hit[0], raw);
            const hood = map.queryRenderedFeatures(e.point, { layers: ["hood-fill"] });
            if (hood.length) setNeighborhood(state.nb === hood[0].id ? -1 : hood[0].id);
        });
        for (const layer of ["permits", "agg-circles"]) {
            map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
            map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
        }
        updateMap();
        if (state.nb >= 0) zoomToNeighborhood();
    });

    const legend = document.createElement("div");
    legend.className = "map-legend";
    legend.id = "map-legend";
    document.getElementById("map").appendChild(legend);
    updateMapLegend();
}

function updateMapLegend() {
    const el = document.getElementById("map-legend");
    if (!el) return;
    const aggregated = state.nb < 0 && (!map || map.getZoom() < (AGG_FADE[0] + AGG_FADE[1]) / 2);
    el.innerHTML = aggregated
        ? `<strong>Total units by neighborhood</strong><div>Zoom in or click a circle to see projects</div>`
        : `<strong>Units per project</strong><div class="map-legend__sizes">${[1, 10, 100, 500].map(u => {
            const r = 2 + 0.95 * Math.sqrt(u);   // matches the circle size at zoom 12
            return `<span><i style="width:${2 * r}px;height:${2 * r}px"></i>${u}</span>`;
        }).join("")}</div>`;
}

const AGG_FADE = [10.6, 11.4];   // zoom range where neighborhood totals fade into project dots

// Project dots fade in as the neighborhood circles fade out, unless a neighborhood is selected
function dotOpacity() {
    const byUnits = ["interpolate", ["linear"], ["get", "u"], 1, 0.35, 10, 0.85];
    return state.nb >= 0
        ? ["interpolate", ["linear"], ["zoom"], 10, byUnits, 13, 0.8]
        : ["interpolate", ["linear"], ["zoom"], AGG_FADE[0], 0, AGG_FADE[1], byUnits, 13, 0.8];
}

// Neighborhood totals for the current filters (measure, dates, housing types)
let HOOD_CENTERS;
function aggregateByNeighborhood() {
    HOOD_CENTERS ||= HOODS_GEO.features.map(f => d3.geoCentroid(f));
    const sums = HOODS.map(() => Object.fromEntries(TYPES.map(t => [t.key, 0])));
    const { fromNum, toNum } = dateRange();
    for (const p of P) {
        if (p.nb < 0 || p.added <= 0) continue;
        if (state.measure === "cofo" && p.cnum < COFO_START) continue;
        const d = state.measure === "issue" ? p.inum : p.cnum;
        if (d < fromNum || d > toNum) continue;
        for (const c of p.comps) if (c.units > 0 && !state.hidden.has(c.type)) sums[p.nb][c.type] += c.units;
    }
    const totals = sums.map(s => d3.sum(Object.values(s)));
    const max = d3.max(totals) || 1;
    return {
        type: "FeatureCollection",
        features: HOODS.map((name, id) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: HOOD_CENTERS[id] },
            properties: {
                id, name, units: totals[id], ...sums[id],
                r: totals[id] ? 3 + 24 * Math.sqrt(totals[id] / max) : 0,
                label: totals[id] >= 1000 ? `${d3.format(".1~f")(totals[id] / 1000)}k` : String(totals[id]),
            },
        })),
    };
}

function showPermitPopup(f, raw) {
    const i = f.properties.i, p = P[i];
    const statusLabel = STATUS.find(s => s.key === p.status)?.label ?? "";
    const units = p.comps.map(c => `${fmt(c.units)} ${c.type === "adu" ? "ADU" : c.units === 1 ? "unit" : "units"}`).join(" + ");
    new maplibregl.Popup({ maxWidth: "280px" })
        .setLngLat(f.geometry.coordinates)
        .setHTML(`<div class="popup"><h3>${esc(raw.addr[i])}</h3><dl>
            <dt>Units</dt><dd>${units}</dd>
            <dt>Issued</dt><dd>${p.issue}</dd>
            <dt>CofO</dt><dd>${p.cofo || "–"}</dd>
            <dt>Status</dt><dd>${statusLabel}</dd>
            <dt>Neighborhood</dt><dd>${p.nb >= 0 ? esc(HOODS[p.nb]) : "–"}</dd>
            <dt>Permit</dt><dd>${esc(raw.id[i])}</dd>
            ${raw.loc[i] === "b" ? "<dt>Location</dt><dd>Approximate</dd>" : ""}
        </dl></div>`)
        .addTo(map);
}

function updateMap() {
    if (!map || !map.getLayer("permits")) return;
    map.setPaintProperty("permits", "circle-color",
        ["match", ["get", "t"], ...TYPES.flatMap((c, idx) => [idx, c.color]), "#999"]);

    const field = state.measure === "issue" ? "is" : "cs";
    const { fromNum, toNum } = dateRange();
    const filter = ["all",
        [">=", ["get", field], Math.max(fromNum, state.measure === "issue" ? 1 : COFO_START)],
        ["<=", ["get", field], toNum]];
    if (state.nb >= 0) filter.push(["==", ["get", "n"], state.nb]);
    const hiddenIdx = TYPES.map((c, idx) => (state.hidden.has(c.key) ? idx : -1)).filter(i => i >= 0);
    if (hiddenIdx.length) filter.push(["!", ["in", ["get", "t"], ["literal", hiddenIdx]]]);
    map.setFilter("permits", filter);
    map.setFilter("hood-selected", ["==", ["id"], state.nb]);
    map.setPaintProperty("permits", "circle-opacity", dotOpacity());
    map.getSource("hood-agg").setData(aggregateByNeighborhood());
    for (const layer of ["agg-circles", "agg-labels"]) map.setLayoutProperty(layer, "visibility", state.nb >= 0 ? "none" : "visible");
    updateMapLegend();
}

function zoomToNeighborhood() {
    if (!map || !map.getLayer("permits")) return;
    if (state.nb < 0) return map.flyTo({ center: [-118.41, 34.03], zoom: 9.4 });
    const b = d3.geoBounds(HOODS_GEO.features[state.nb]);
    map.fitBounds([b[0], b[1]], { padding: 40, maxZoom: 14 });
}

// --- Controls ----------------------------------------------------------------------------------

function setNeighborhood(nb) {
    state.nb = nb;
    render();
    zoomToNeighborhood();
}

function toggleType(key) {
    state.hidden.has(key) ? state.hidden.delete(key) : state.hidden.add(key);
    render();
}

// Both filter bars (top of page and above the map) use data-bind; keep them all in sync with state
function syncControls() {
    document.querySelectorAll(".segmented[data-bind]").forEach(group => {
        group.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.value === state[group.dataset.bind])));
    });
    const { from, to } = dateRange();
    document.querySelectorAll("[data-bind=nb]").forEach(el => (el.value = String(state.nb)));
    document.querySelectorAll("[data-bind=preset]").forEach(el => (el.value = state.preset));
    document.querySelectorAll("[data-bind=rate]").forEach(el => (el.value = state.rate));
    document.querySelectorAll("[data-bind=from]").forEach(el => (el.value = ymd(from)));
    document.querySelectorAll("[data-bind=to]").forEach(el => (el.value = ymd(to)));
    document.querySelectorAll("[data-bind=types]").forEach(el => {
        el.innerHTML = [...TYPES].reverse().map(t => `<button type="button" class="chip" data-type="${t.key}" aria-pressed="${!state.hidden.has(t.key)}"><span class="legend__swatch" style="background:${t.color}"></span>${t.label}</button>`).join("");
    });
}

function bindControls() {
    const max = ymd(today()), min = ymd(START);
    document.querySelectorAll("[data-bind=from], [data-bind=to]").forEach(el => { el.min = min; el.max = max; });
    document.querySelectorAll("[data-bind=nb]").forEach(sel => HOODS.forEach((name, idx) => sel.add(new Option(name, idx))));
    document.querySelectorAll("[data-bind=preset]").forEach(sel => PRESETS.forEach(p => sel.add(new Option(p.label, p.key))));

    document.addEventListener("click", e => {
        const chip = e.target.closest("[data-type]");
        if (chip) return toggleType(chip.dataset.type);
        const b = e.target.closest(".segmented[data-bind] button");
        if (!b) return;
        state[b.parentElement.dataset.bind] = b.dataset.value;
        render();
    });
    document.addEventListener("change", e => {
        const key = e.target.dataset.bind;
        if (key === "nb") return setNeighborhood(+e.target.value);
        if (key === "rate") state.rate = e.target.value;
        if (key === "preset") {
            if (e.target.value === "custom") { state.preset = "custom"; return syncControls(); }
            applyPreset(e.target.value);
        }
        if ((key === "from" || key === "to") && e.target.value) {
            state.preset = "custom";
            const { from, to } = dateRange();
            state.from = from; state.to = to;
            state[key] = day(e.target.value);
            if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
            autoGrain();
        }
        if (key) render();
    });
    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(render, 150); });
}

function render() {
    const verb = state.measure === "issue" ? "permitted" : "completed";
    const where = state.nb >= 0 ? ` in ${HOODS[state.nb]}` : "";
    document.getElementById("chart-title").textContent = `Housing units ${verb}${where}`;
    document.getElementById("map-title").textContent = `Where it was ${verb}${where}, ${rangeLabel()}`;
    syncControls();
    renderLegend();
    renderStats();
    renderChart();
    renderHoodEvents();
    const rows = pipelineRows();
    renderPipeline(rows);
    renderDurations(rows);
    updateMap();
}

let HOODS_GEO;
Promise.all(["data/permits.json", "data/rates.json", "data/events.json", "data/meta.json", "data/neighborhoods.geojson"]
    .map(u => fetch(u).then(r => r.json())))
    .then(([file, rates, events, meta, hoods]) => {
        const raw = toColumns(file);
        P = prepare(raw);
        RATES = rates;
        EVENTS = events;
        HOODS = raw.neighborhoods;
        HOODS_GEO = hoods;
        document.getElementById("updated").textContent = d3.timeFormat("%B %-d, %Y")(new Date(`${meta.updated}T12:00:00`));
        document.querySelectorAll(".cfg-stalled").forEach(el => (el.textContent = meta.stalled_after_years));
        document.querySelectorAll("[data-year]").forEach(el => (el.textContent = new Date().getFullYear()));
        bindControls();
        render();
        initMap(raw, hoods);
    })
    .catch(err => {
        console.error(err);
        document.getElementById("chart").textContent = "The data couldn't be loaded. Please try again later.";
    });
