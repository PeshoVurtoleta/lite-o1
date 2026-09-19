/**
 * @zakkster/lite-o1 -- benchmark report renderer (zero-dep, hand-rolled SVG).
 *
 *     node benchmark/Report.mjs      # reads benchmark/results.json -> report.html
 *
 * Repo-only. Renders the collected results (benchmark/results.json, written by
 * Bench.mjs) to a SELF-CONTAINED, ZERO-DEPENDENCY HTML file with HAND-ROLLED
 * inline SVG charts -- no charting library, no web fonts, no external assets.
 * Theme-neutral, ASCII-only (`->`, `<=`, `x`), safe to open from disk.
 *
 * exports: renderSvg (one chart spec -> an <svg> string), renderHtml (the full
 * payload -> a complete HTML document).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paretoFrontier, sparseTax } from './Template.mjs';
import { CAPACITY_KNOB, NA } from './Matrix.mjs';

const RESULTS_PATH = fileURLToPath(new URL('./results.json', import.meta.url));
const REPORT_PATH = fileURLToPath(new URL('./report.html', import.meta.url));

const PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2'];

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function num(x) {
    if (typeof x !== 'number' || !isFinite(x)) return String(x);
    if (x === 0) return '0';
    if (x >= 1000) return x.toFixed(0);
    if (x >= 1) return x.toFixed(2);
    return x.toFixed(4);
}
/** Render a Mann-Whitney result as "sig p=.." / "ns p=.." / the NA string (never 0). */
function sig(mw) {
    if (!mw || typeof mw !== 'object') return String(mw);
    return (mw.significant ? 'sig' : 'ns') + ' p=' + (mw.p < 0.001 ? '<.001' : mw.p.toFixed(3));
}

// ---------------------------------------------------------------------------
// Hand-rolled SVG primitives.
// ---------------------------------------------------------------------------
function barChartSvg(spec) {
    const W = 640, H = 300, PADL = 56, PADB = 54, PADT = 28, PADR = 16;
    const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
    const labels = spec.labels;
    const series = spec.series; // [{name, values, color}]
    const groups = labels.length;
    const perGroup = series.length;
    let max = 0;
    for (const s of series) for (const v of s.values) if (v > max) max = v;
    if (max <= 0) max = 1;
    const gGap = plotW / groups;
    const bW = (gGap * 0.72) / perGroup;

    let bars = '';
    for (let g = 0; g < groups; g++) {
        const gx = PADL + g * gGap + gGap * 0.14;
        for (let s = 0; s < perGroup; s++) {
            const v = series[s].values[g] || 0;
            const h = (v / max) * plotH;
            const x = gx + s * bW;
            const y = PADT + plotH - h;
            bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' +
                (bW * 0.9).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + series[s].color + '"/>';
        }
        bars += '<text x="' + (PADL + g * gGap + gGap / 2).toFixed(1) + '" y="' + (H - PADB + 16) +
            '" font-size="11" text-anchor="middle" fill="#334155">' + esc(labels[g]) + '</text>';
    }
    // y axis ticks
    let ticks = '';
    for (let t = 0; t <= 4; t++) {
        const v = (max * t) / 4;
        const y = PADT + plotH - (t / 4) * plotH;
        ticks += '<line x1="' + PADL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PADR) + '" y2="' +
            y.toFixed(1) + '" stroke="#e2e8f0"/>';
        ticks += '<text x="' + (PADL - 6) + '" y="' + (y + 4).toFixed(1) +
            '" font-size="10" text-anchor="end" fill="#64748b">' + num(v) + '</text>';
    }
    let legend = '';
    for (let s = 0; s < perGroup; s++) {
        legend += '<rect x="' + (PADL + s * 150) + '" y="6" width="12" height="12" fill="' + series[s].color + '"/>' +
            '<text x="' + (PADL + s * 150 + 16) + '" y="16" font-size="11" fill="#334155">' + esc(series[s].name) + '</text>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' +
        esc(spec.title) + '">' +
        '<text x="' + (W / 2) + '" y="' + (H - 6) + '" font-size="11" text-anchor="middle" fill="#475569">' +
        esc(spec.xlabel || '') + '</text>' +
        '<text x="14" y="' + (PADT + plotH / 2) + '" font-size="11" text-anchor="middle" fill="#475569" transform="rotate(-90 14 ' +
        (PADT + plotH / 2) + ')">' + esc(spec.ylabel || '') + '</text>' +
        ticks + bars + legend + '</svg>';
}

function lineChartSvg(spec) {
    const W = 640, H = 300, PADL = 56, PADB = 54, PADT = 28, PADR = 16;
    const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
    const series = spec.series; // [{name, points:[{x,y}], color}]
    let xmin = Infinity, xmax = -Infinity, ymax = 0;
    for (const s of series) for (const p of s.points) {
        const lx = Math.log10(Math.max(1, p.x));
        if (lx < xmin) xmin = lx; if (lx > xmax) xmax = lx;
        if (p.y > ymax) ymax = p.y;
    }
    if (ymax <= 0) ymax = 1;
    if (xmax <= xmin) xmax = xmin + 1;
    const sx = (x) => PADL + ((Math.log10(Math.max(1, x)) - xmin) / (xmax - xmin)) * plotW;
    const sy = (y) => PADT + plotH - (y / ymax) * plotH;

    let ticks = '';
    for (let t = 0; t <= 4; t++) {
        const v = (ymax * t) / 4;
        const y = PADT + plotH - (t / 4) * plotH;
        ticks += '<line x1="' + PADL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PADR) + '" y2="' +
            y.toFixed(1) + '" stroke="#e2e8f0"/>';
        ticks += '<text x="' + (PADL - 6) + '" y="' + (y + 4).toFixed(1) +
            '" font-size="10" text-anchor="end" fill="#64748b">' + num(v) + '</text>';
    }
    for (let t = 0; t <= 4; t++) {
        const lx = xmin + ((xmax - xmin) * t) / 4;
        const x = PADL + (t / 4) * plotW;
        ticks += '<text x="' + x.toFixed(1) + '" y="' + (H - PADB + 16) +
            '" font-size="10" text-anchor="middle" fill="#64748b">1e' + lx.toFixed(1) + '</text>';
    }
    let paths = '';
    for (const s of series) {
        let d = '';
        for (let i = 0; i < s.points.length; i++) {
            const p = s.points[i];
            d += (i === 0 ? 'M' : 'L') + sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1) + ' ';
        }
        paths += '<path d="' + d.trim() + '" fill="none" stroke="' + s.color + '" stroke-width="2"/>';
        for (const p of s.points) {
            paths += '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) +
                '" r="2.5" fill="' + s.color + '"/>';
        }
    }
    let legend = '';
    for (let s = 0; s < series.length; s++) {
        legend += '<rect x="' + (PADL + s * 150) + '" y="6" width="12" height="12" fill="' + series[s].color + '"/>' +
            '<text x="' + (PADL + s * 150 + 16) + '" y="16" font-size="11" fill="#334155">' + esc(series[s].name) + '</text>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' +
        esc(spec.title) + '">' +
        '<text x="' + (W / 2) + '" y="' + (H - 6) + '" font-size="11" text-anchor="middle" fill="#475569">' +
        esc(spec.xlabel || '') + '</text>' +
        '<text x="14" y="' + (PADT + plotH / 2) + '" font-size="11" text-anchor="middle" fill="#475569" transform="rotate(-90 14 ' +
        (PADT + plotH / 2) + ')">' + esc(spec.ylabel || '') + '</text>' +
        ticks + paths + legend + '</svg>';
}

/** Space-time Pareto scatter: x = bytes/live (compact <-), y = ops/ms (fast ^). Points
 * on the dominance frontier are drawn filled + connected; dominated points are hollow. */
function scatterChartSvg(spec) {
    const W = 640, H = 320, PADL = 60, PADB = 56, PADT = 28, PADR = 16;
    const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
    const pts = spec.points; // [{label, x, y, onFrontier}]
    let xmin = Infinity, xmax = -Infinity, ymax = 0;
    for (const p of pts) {
        if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
        if (p.y > ymax) ymax = p.y;
    }
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; }
    if (xmax <= xmin) xmax = xmin + 1;
    if (ymax <= 0) ymax = 1;
    const sx = (x) => PADL + ((x - xmin) / (xmax - xmin)) * plotW;
    const sy = (y) => PADT + plotH - (y / ymax) * plotH;
    let ticks = '';
    for (let t = 0; t <= 4; t++) {
        const vy = (ymax * t) / 4, yy = PADT + plotH - (t / 4) * plotH;
        ticks += '<line x1="' + PADL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PADR) + '" y2="' +
            yy.toFixed(1) + '" stroke="#e2e8f0"/>';
        ticks += '<text x="' + (PADL - 6) + '" y="' + (yy + 4).toFixed(1) +
            '" font-size="10" text-anchor="end" fill="#64748b">' + num(vy) + '</text>';
        const vx = xmin + ((xmax - xmin) * t) / 4, xx = PADL + (t / 4) * plotW;
        ticks += '<text x="' + xx.toFixed(1) + '" y="' + (H - PADB + 16) +
            '" font-size="10" text-anchor="middle" fill="#64748b">' + num(vx) + '</text>';
    }
    // Connect the frontier points left-to-right (ascending bytes/live).
    const front = pts.filter((p) => p.onFrontier).slice().sort((a, b) => a.x - b.x);
    let path = '';
    for (let i = 0; i < front.length; i++) {
        path += (i === 0 ? 'M' : 'L') + sx(front[i].x).toFixed(1) + ' ' + sy(front[i].y).toFixed(1) + ' ';
    }
    let dots = '';
    if (path) dots += '<path d="' + path.trim() + '" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="4 3"/>';
    for (const p of pts) {
        const cx = sx(p.x).toFixed(1), cy = sy(p.y).toFixed(1);
        dots += '<circle cx="' + cx + '" cy="' + cy + '" r="4" fill="' +
            (p.onFrontier ? '#2563eb' : 'none') + '" stroke="#2563eb" stroke-width="1.5"/>';
        dots += '<text x="' + (sx(p.x) + 6).toFixed(1) + '" y="' + (sy(p.y) - 6).toFixed(1) +
            '" font-size="9" fill="#334155">' + esc(p.label) + '</text>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(spec.title) + '">' +
        '<text x="' + (W / 2) + '" y="' + (H - 6) + '" font-size="11" text-anchor="middle" fill="#475569">' +
        esc(spec.xlabel || '') + '</text>' +
        '<text x="14" y="' + (PADT + plotH / 2) + '" font-size="11" text-anchor="middle" fill="#475569" transform="rotate(-90 14 ' +
        (PADT + plotH / 2) + ')">' + esc(spec.ylabel || '') + '</text>' +
        ticks + dots + '</svg>';
}

/**
 * Render one chart spec to an <svg> string.
 * @param {{type:'bar'|'line'|'scatter'}} spec
 * @returns {string}
 */
export function renderSvg(spec) {
    if (spec.type === 'bar') return barChartSvg(spec);
    if (spec.type === 'line') return lineChartSvg(spec);
    if (spec.type === 'scatter') return scatterChartSvg(spec);
    throw new Error('[report] unknown chart type ' + String(spec.type));
}

// ---------------------------------------------------------------------------
// Section builders.
// ---------------------------------------------------------------------------
function tableRows(headers, rows) {
    let h = '<tr>';
    for (const c of headers) h += '<th>' + esc(c) + '</th>';
    h += '</tr>';
    let b = '';
    for (const r of rows) {
        b += '<tr>';
        for (const c of r) b += '<td>' + esc(c) + '</td>';
        b += '</tr>';
    }
    return '<table>' + h + b + '</table>';
}

function section(title, note, chart, table) {
    return '<section><h2>' + esc(title) + '</h2>' +
        (note ? '<p class="note">' + esc(note) + '</p>' : '') +
        (chart ? '<div class="chart">' + chart + '</div>' : '') +
        (table || '') + '</section>';
}

/**
 * Render the full payload (benchmark/results.json shape) to an HTML document.
 * @param {object} payload
 * @returns {string}
 */
export function renderHtml(payload) {
    const R = payload.results;
    const subjects = payload.subjects;
    const get = (m, d) => R[m + '/' + d];
    const color = (i) => PALETTE[i % PALETTE.length];
    const sections = [];

    // D1 -- latency distribution.
    {
        const chart = renderSvg({
            type: 'bar', title: 'D1 tail latency', xlabel: 'member', ylabel: 'ns/op',
            labels: subjects,
            series: [
                { name: 'p50', color: color(0), values: subjects.map((m) => get(m, 'D1').subject.p50) },
                { name: 'p99', color: color(1), values: subjects.map((m) => get(m, 'D1').subject.p99) },
                { name: 'max', color: color(2), values: subjects.map((m) => get(m, 'D1').subject.max) },
            ],
        });
        const rows = subjects.map((m) => {
            const r = get(m, 'D1');
            const s = r.subject; const g = r.subjectGc;
            const ci = r.ci;
            const band = (ci && typeof ci === 'object') ? (num(ci.lo) + '..' + num(ci.hi)) : String(ci);
            const rciw = (ci && typeof ci === 'object') ? num(ci.rciw) : String(ci);
            // Bench v3: the max single op's KERNEL-SUPPLIED structural tag (from the untimed
            // replay), with its spikeRatio = max/p99. 'steady' is a truth, not a gap.
            const a = r.attribution;
            const tag = (a && typeof a === 'object') ? (a.tag + ' (' + num(a.spikeRatio) + 'x)') : String(a);
            return [m, num(s.p50), num(s.p90), num(s.p99), num(s.p999), String(s.p9999), num(s.max),
                num(g.p99), num(g.max), band, rciw, sig(r.vsPrimary), sig(r.vsStrong), tag];
        });
        sections.push(section('D1 -- Latency distribution + fairness audit',
            'Per-op tail latency (ns/op), subject; p99(gc)/max(gc) are under forced GC. ' +
            'CI is the 95% bootstrap band of the subject median (rciw = relative width); ' +
            'sig(primary)/sig(strong) are the Mann-Whitney verdicts vs the primary and STRONG ' +
            'foils (n/a where no strong baseline exists -- never 0). max tag = the structural ' +
            'event behind the worst single op (kernel-supplied via an untimed replay, never ' +
            'timing-inferred; n/a for the worst-case-O(1) members with no tail).',
            chart, tableRows(['member', 'p50', 'p90', 'p99', 'p99.9', 'p99.99', 'max',
                'p99(gc)', 'max(gc)', 'ci lo..hi', 'rciw', 'vs primary', 'vs strong', 'max tag'], rows)));
    }

    // D2 -- amortized cost.
    {
        const chart = renderSvg({
            type: 'line', title: 'D2 amortized', xlabel: 'ops (log10)', ylabel: 'cumulative ns/op',
            series: subjects.map((m, i) => ({
                name: m, color: color(i),
                points: get(m, 'D2').points.map((p) => ({ x: p.ops, y: p.nsPerOp })),
            })),
        });
        const rows = subjects.map((m) => {
            const r = get(m, 'D2');
            // Bench v3: boundary-crossing trace -- the tag + the op indices where a
            // structural boundary is crossed MULTIPLE times (spikes align there, the
            // steady segments between stay flat). n/a for members with no periodic boundary.
            const b = r.boundary;
            const bd = (b && typeof b === 'object')
                ? (b.tag + ' x' + b.crossings.length + ' [' + b.crossings.slice(0, 6).join(',') +
                    (b.crossings.length > 6 ? ',...' : '') + ']')
                : String(b);
            return [m, num(r.drift), bd];
        });
        sections.push(section('D2 -- Amortized cost over a long mixed trace',
            'Cumulative ns/op at power-of-two checkpoints; a flat line (drift ~ 1.0) proves the amortized bound holds. ' +
            'boundary-crossing = the structural event + the op indices where the trace crosses a ' +
            'capacity/period boundary repeatedly (the spikes align there); n/a where a member has no periodic boundary.',
            chart, tableRows(['member', 'drift (last/first)', 'boundary-crossing trace'], rows)));
    }

    // D3 -- memory.
    {
        const chart = renderSvg({
            type: 'bar', title: 'D3 memory', xlabel: 'member', ylabel: 'bytes / live element',
            labels: subjects,
            series: [
                { name: 'bytes/live', color: color(0), values: subjects.map((m) => get(m, 'D3').bytesPerLive) },
                { name: 'theo min', color: color(2), values: subjects.map((m) => get(m, 'D3').theoreticalMinPerLive) },
            ],
        });
        const rows = subjects.map((m) => {
            const r = get(m, 'D3');
            const curve = Array.isArray(r.loadFactorCurve)
                ? r.loadFactorCurve.map((p) => num(p.overheadRatio)).join(' / ') : 'n/a';
            return [m, String(r.peakBackingBytes), num(r.bytesPerLive), String(r.theoreticalMinPerLive),
                num(r.overheadRatio), curve, num(r.heapAfterClearKB) + ' KB'];
        });
        sections.push(section('D3 -- Memory footprint + stability',
            'Fixed-capacity members reuse one backing store; peak bytes are constant by design. clear() retains the buffer (stated, not implicit). ' +
            'The overhead-x curve is bytes-per-live / theoretical-min at load factors 0.25 / 0.5 / 0.75 / 1.0 -- ' +
            'it RISES as load falls (fixed backing over fewer live), surfacing FreqO1 free-list + universe-array overhead as a curve, not a point.',
            chart, tableRows(['member', 'peak bytes', 'B/live', 'theo min', 'overhead x',
                'overhead x @ 0.25/0.5/0.75/1.0', 'heap after clear'], rows)));
    }

    // Space-time Pareto + build-cost + sparse-tax (Bench v3, upgrade 3).
    {
        // Pareto: the 12 capacity-knob members on the ops/ms (from D1: 1e6/p50) vs
        // bytes/live (D3) plane -- REAL measured cells, a pure dominance filter (no fit).
        const knob = subjects.filter((m) => CAPACITY_KNOB[m]);
        const raw = knob.map((m) => {
            const d1 = get(m, 'D1'); const d3 = get(m, 'D3');
            const p50 = d1.subject.p50;
            return { member: m, opsPerMs: p50 > 0 ? 1e6 / p50 : 0, bytesPerLive: d3.bytesPerLive };
        });
        const front = paretoFrontier(raw);
        const onFront = new Set(front.map((p) => p.member));
        const chart = renderSvg({
            type: 'scatter', title: 'Space-time Pareto',
            xlabel: 'bytes / live element (more compact <-)', ylabel: 'ops / ms (faster ^)',
            points: raw.map((p) => ({ label: p.member, x: p.bytesPerLive, y: p.opsPerMs, onFrontier: onFront.has(p.member) })),
        });
        const paretoRows = raw.map((p) => [p.member, num(p.opsPerMs), num(p.bytesPerLive),
            onFront.has(p.member) ? 'FRONTIER' : 'dominated']);

        // Sparse tax: the fixed-cap "pay for the worst case even when sparse" ratio
        // (bytes/live @ 0.25 / @ 1.0), read off the EXISTING D3 loadFactorCurve (no new run).
        const taxRows = subjects.map((m) => {
            const d3 = get(m, 'D3');
            const tax = Array.isArray(d3.loadFactorCurve) ? sparseTax(d3.loadFactorCurve) : NA;
            return [m, (typeof tax === 'number' ? num(tax) + 'x' : String(tax))];
        });

        // Build-cost panel: the STATIC member's build cost is on NEITHER Pareto axis, so
        // it gets its own row -- buildNs + buildBytes, a DISTINCT key from any query latency.
        const staticRows = subjects.filter((m) => !CAPACITY_KNOB[m]).map((m) => {
            const d3 = get(m, 'D3'); const d1 = get(m, 'D1');
            return [m, num(d3.buildNs) + ' ns', String(d3.buildBytes) + ' B', num(d1.subject.p50) + ' ns/query'];
        });

        sections.push(section('Space-time Pareto + build cost + sparse tax',
            'The 12 capacity-knob members on the space-time plane: ops/ms (D1, 1e6/p50) vs bytes/live (D3) ' +
            '-- REAL measured points, a pure dominance filter (filled = on the frontier, hollow = dominated), ' +
            'no curve fit. Sparse tax = bytes/live at load 0.25 / at load 1.0 (fixed-cap members reserve for the ' +
            'ceiling, so it sits above 1x). The static SparseTable is shown separately: its build cost is a ' +
            'DISTINCT number, never folded into the O(1) query latency.',
            chart,
            tableRows(['member', 'ops/ms', 'bytes/live', 'pareto'], paretoRows) +
            '<h2>Sparse tax (bytes/live @0.25 / @1.0)</h2>' +
            tableRows(['member', 'sparse tax'], taxRows) +
            '<h2>Static build cost (separate from query latency)</h2>' +
            tableRows(['member', 'build ns', 'build bytes', 'query latency'], staticRows)));
    }

    // D4 -- cache proxy.
    {
        const chart = renderSvg({
            type: 'line', title: 'D4 cache proxy', xlabel: 'working set (log10 elements)', ylabel: 'ns/element (dense iter)',
            series: subjects.map((m, i) => ({
                name: m, color: color(i),
                points: get(m, 'D4').strideSweep.map((p) => ({ x: p.workingSet, y: p.nsPerElem })),
            })),
        });
        const tierRatio = (t) => (t && typeof t === 'object') ? num(t.ratio) : String(t);
        const rows = subjects.map((m) => {
            const r = get(m, 'D4');
            const bands = r.strideSweep.map((p) => p.band).join('/');
            const t = r.tiers || {};
            return [m, bands, tierRatio(t.L1), tierRatio(t.L2), tierRatio(t.L3), tierRatio(t.DRAM),
                num(r.denseNsPerOp), num(r.randomNsPerOp), num(r.gap)];
        });
        sections.push(section('D4 -- Cache behaviour (PROXY, NOMINAL bands)',
            'PROXY ONLY: no native perf counters. Each working-set point carries a NOMINAL cache-tier ' +
            'band (L1 <= 32 KiB, L2 <= 1 MiB, L3 <= 32 MiB, else DRAM) from the measured backing bytes ' +
            '-- a legibility label, NOT a measured cache miss. The per-tier dense/random ratio (n/a where ' +
            'a member has no random-access lookup or a tier is unreached -- never 0) shows the SoA ' +
            'advantage widen as the working set leaves L3. Run `npm run bench -- --deep` to extend the ' +
            'sweep toward a DRAM-resident working set.',
            chart, tableRows(['member', 'sweep bands', 'L1 r/d', 'L2 r/d', 'L3 r/d', 'DRAM r/d',
                'dense ns/op', 'random ns/op', 'gap (random/dense)'], rows)));
    }

    // D5 -- bundle.
    {
        const chart = renderSvg({
            type: 'bar', title: 'D5 bundle', xlabel: 'member', ylabel: 'gzip bytes',
            labels: subjects,
            series: [
                { name: 'single import', color: color(0), values: subjects.map((m) => get(m, 'D5').single.gzip) },
                { name: 'all import', color: color(1), values: subjects.map((m) => get(m, 'D5').all.gzip) },
            ],
        });
        const rows = subjects.map((m) => {
            const r = get(m, 'D5');
            return [m, String(r.single.min), String(r.single.gzip), String(r.all.min), String(r.all.gzip),
                r.ratio.toFixed(3), r.underForty ? 'yes' : 'NO'];
        });
        sections.push(section('D5 -- Bundle size + tree-shaking',
            'esbuild minify + gzip. A single-member import must be < 40% of the all-member import (tree-shaking proof).',
            chart, tableRows(['member', 'single min', 'single gz', 'all min', 'all gz', 'ratio', '< 40%?'], rows)));
    }

    // D6 -- GC pressure.
    {
        const chart = renderSvg({
            type: 'line', title: 'D6 throughput', xlabel: 'n (log10)', ylabel: 'ops/ms',
            series: subjects.map((m, i) => ({
                name: m, color: color(i),
                points: get(m, 'D6').points.map((p) => ({ x: p.n, y: p.opsPerMs })),
            })),
        });
        const rows = subjects.map((m) => {
            const r = get(m, 'D6');
            return [m, String(r.zeroAlloc), String(r.maxMajor), num(r.maxPauseMsPerMillion)];
        });
        sections.push(section('D6 -- GC pressure + allocation-rate curve',
            'The 0 B/op gate as a measured curve over n=1e3..1e6. zeroAlloc=true + maxMajorGC=0 is the pass; throughput line stays flat.',
            chart, tableRows(['member', 'zeroAlloc', 'max major GC', 'max pause ms/1e6op'], rows)));
    }

    // D7 -- scalability.
    {
        const rows = subjects.map((m) => {
            const r = get(m, 'D7');
            // SparseTable is static: loadFactors is the NA string, never an array.
            const lf = Array.isArray(r.loadFactors)
                ? r.loadFactors.map((l) => num(l.nsPerOp)).join(' / ') : String(r.loadFactors);
            return [m, String(r.keyTypes.int), String(r.keyTypes.string), String(r.keyTypes.object),
                lf, num(r.nearFullNs), String(r.justResizedNs)];
        });
        sections.push(section('D7 -- Scalability across key types + load factors',
            'lite-o1 members are integer/numeric substrates: string + object keys read n/a (never 0). Load factors 0.3/0.5/0.7/0.9; fixed-capacity members never resize (just-resized n/a).',
            null, tableRows(['member', 'int ns/op', 'string', 'object', 'load 0.3/0.5/0.7/0.9', '99% full', 'just resized'], rows)));
    }

    // D8 -- workloads.
    {
        const rows = subjects.map((m) => {
            const r = get(m, 'D8');
            const ecs = typeof r.ecs === 'object'
                ? (num(r.ecs.denseIterNsPerElem) + ' iter / ' + num(r.ecs.randomHasNsPerOp) + ' has') : String(r.ecs);
            const cache = typeof r.cache === 'object' ? num(r.cache.nsPerOp) : String(r.cache);
            const churn = typeof r.churn === 'object' ? num(r.churn.nsPerOp) : String(r.churn);
            const query = typeof r.query === 'object' ? num(r.query.nsPerOp) : String(r.query);
            return [m, ecs, cache, churn, query];
        });
        sections.push(section('D8 -- Workload micro-benchmarks',
            'ECS dense-iter + random has (SparseSet), cache hot-subset (SparseSet), churn insert/delete same keys (mutable members), query wide-range (SparseTable, the static-member workload). Inapplicable workloads read n/a.',
            null, tableRows(['member', 'ECS (ns)', 'cache hot-subset ns/op', 'churn ns/op', 'query ns/op'], rows)));
    }

    const meta = payload.meta;
    const head = '<header><h1>@zakkster/lite-o1 -- benchmark report</h1>' +
        '<p class="meta">seed 0x' + (meta.seed >>> 0).toString(16) + ' | node ' + esc(meta.node) +
        ' | ' + esc(meta.arch) + '/' + esc(meta.platform) + ' | ' + esc(meta.date) + '</p>' +
        '<p class="note">Repo-only measurement infra. Every member is measured against a JS built-in baseline. ' +
        'D4 is a PORTABLE PROXY (dense-iter vs random-lookup + stride sweep) -- no native perf counters.</p></header>';

    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>lite-o1 benchmark report</title><style>' + STYLE + '</style></head><body>' +
        head + sections.join('') + '</body></html>';
}

const STYLE =
    ':root{--bg:#f8fafc;--card:#ffffff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;padding:1.5rem;background:var(--bg);color:var(--ink);' +
    'font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    'header{max-width:56rem;margin:0 auto 1.5rem}' +
    'h1{font-size:1.5rem;margin:0 0 .3rem}h2{font-size:1.15rem;margin:0 0 .5rem}' +
    '.meta{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;margin:.2rem 0}' +
    '.note{color:var(--muted);font-size:.85rem;margin:.2rem 0 .8rem}' +
    'section{max-width:56rem;margin:0 auto 1.5rem;background:var(--card);border:1px solid var(--line);' +
    'border-radius:.6rem;padding:1rem 1.2rem}' +
    '.chart{margin:.5rem 0 1rem}' +
    'table{width:100%;border-collapse:collapse;font-size:.85rem;' +
    'font-variant-numeric:tabular-nums}' +
    'th,td{text-align:right;padding:.35rem .5rem;border-bottom:1px solid var(--line)}' +
    'th:first-child,td:first-child{text-align:left}' +
    'th{color:var(--muted);font-weight:600}';

// ---------------------------------------------------------------------------
// CLI: read results.json, write report.html (fail closed if results missing).
// ---------------------------------------------------------------------------
function main() {
    let payload;
    try {
        payload = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
    } catch (e) {
        process.stderr.write('[report] cannot read benchmark/results.json -- run `npm run bench` first (' +
            e.message + ')\n');
        process.exit(1);
    }
    const html = renderHtml(payload);
    writeFileSync(REPORT_PATH, html);
    process.stdout.write('report written to benchmark/report.html (' +
        Buffer.byteLength(html) + ' bytes)\n');
}

if (import.meta.url === 'file://' + process.argv[1] || process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
