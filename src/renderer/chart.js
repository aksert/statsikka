'use strict';
// Pieni inline-SVG viivakaavio. Ei kirjastoja, ei innerHTML:ää; värit tulevat CSS-muuttujista (.ch-* luokat).
(function () {
  const { h } = U;
  const NS = 'http://www.w3.org/2000/svg';
  const ML = 70, MR = 16, MT = 14, MB = 28;
  const MAX_DOTS = 300;

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = v; else el.setAttribute(k, String(v));
      }
    }
    for (const c of kids) if (c) el.appendChild(c);
    return el;
  }
  const f1 = (n) => String(Math.round(n * 10) / 10);

  // Siistit askelarvot (1, 2, 5 × 10^n) ~count tickille.
  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function thin(ticks, max) {
    if (ticks.length <= max) return ticks;
    const k = Math.ceil(ticks.length / max);
    return ticks.filter((_, i) => i % k === 0);
  }
  function timeLabel(ts, spanMs) {
    const d = new Date(ts);
    if (spanMs <= 2 * 86400000) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${d.getDate()}.${d.getMonth() + 1}.`;
  }

  // opts: { series:[{ name, cls (0–4), step?, points:[{ x, y, title }] }], xKind:'time'|'index',
  //         yTicks?:[{ value, label }], yFormat?:fn, yPad?:number, yMin?, yMax?, markers?:[{ x, label }], label? }
  function lineChart(opts) {
    const W = opts.width || 900, H = opts.height || 260; // viewBox; leveys 100 % skaalaa, joten puolileveään korttiin annetaan pienempi width
    const series = (opts.series || []).map((sr) => ({ ...sr, points: (sr.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) }))
      .filter((sr) => sr.points.length > 0);
    const enough = series.some((sr) => sr.points.length >= 2);
    if (!enough) return h('div', { class: 'chart chart-empty', text: 'Ei vielä tarpeeksi dataa' });

    const all = series.flatMap((sr) => sr.points);
    let x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x));
    if (x1 === x0) { x0 -= 1; x1 += 1; }
    let y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
    const pad = opts.yPad != null ? opts.yPad : (y1 === y0 ? 1 : (y1 - y0) * 0.1);
    y0 -= pad; y1 += pad;
    if (opts.yMin != null) y0 = Math.min(y0, opts.yMin);
    if (opts.yMax != null) y1 = Math.max(y1, opts.yMax);

    const fmt = opts.yFormat || ((v) => f1(v));
    let yTicks;
    if (opts.yTicks) yTicks = thin(opts.yTicks.filter((t) => t.value >= y0 && t.value <= y1), 6);
    else yTicks = niceTicks(y0, y1, 4).map((v) => ({ value: v, label: fmt(v) }));
    if (yTicks.length === 0) yTicks = [{ value: (y0 + y1) / 2, label: fmt((y0 + y1) / 2) }];

    const px = (x) => ML + ((x - x0) / (x1 - x0)) * (W - ML - MR);
    const py = (y) => MT + (1 - (y - y0) / (y1 - y0)) * (H - MT - MB);

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': opts.label || 'Kaavio', class: 'chart-svg' });
    for (const t of yTicks) {
      svg.appendChild(s('line', { class: 'ch-grid', x1: ML, x2: W - MR, y1: f1(py(t.value)), y2: f1(py(t.value)) }));
      svg.appendChild(s('text', { class: 'ch-tick', x: ML - 8, y: f1(py(t.value) + 4), 'text-anchor': 'end', text: t.label }));
    }
    svg.appendChild(s('line', { class: 'ch-axis', x1: ML, x2: W - MR, y1: H - MB, y2: H - MB }));
    const xTicks = opts.xKind === 'time'
      ? [0, 1, 2, 3].map((i) => x0 + ((x1 - x0) * i) / 3)
      : niceTicks(x0, x1, 4).filter((v) => Number.isInteger(v));
    const spanMs = x1 - x0;
    const seen = new Set();
    for (const v of xTicks) {
      const label = opts.xKind === 'time' ? timeLabel(v, spanMs) : String(Math.round(v));
      if (seen.has(label)) continue;
      seen.add(label);
      svg.appendChild(s('text', { class: 'ch-tick', x: f1(px(v)), y: H - 8, 'text-anchor': 'middle', text: label }));
    }
    for (const m of opts.markers || []) {
      if (m.x < x0 || m.x > x1) continue;
      svg.appendChild(s('line', { class: 'ch-marker', x1: f1(px(m.x)), x2: f1(px(m.x)), y1: MT, y2: H - MB }));
      svg.appendChild(s('text', { class: 'ch-mark-label', x: f1(px(m.x) + 4), y: MT + 10, text: m.label }));
    }
    for (const sr of series) {
      const pts = sr.points.slice().sort((a, b) => a.x - b.x);
      let d = '';
      pts.forEach((p, i) => {
        const x = f1(px(p.x)), y = f1(py(p.y));
        if (i === 0) d = `M${x} ${y}`;
        else d += sr.step ? ` H${x} V${y}` : ` L${x} ${y}`;
      });
      if (pts.length >= 2) svg.appendChild(s('path', { class: `ch-line c${sr.cls}`, d }));
      for (const p of pts.slice(-MAX_DOTS)) {
        svg.appendChild(s('circle', { class: `ch-dot c${sr.cls}`, cx: f1(px(p.x)), cy: f1(py(p.y)), r: 3.5 },
          s('title', { text: p.title || `${sr.name}: ${fmt(p.y)}` })));
      }
    }

    const legend = series.length > 1 || (opts.series || []).length > 1
      ? h('div', { class: 'chart-legend' }, series.map((sr) => h('span', { class: 'legend-item' }, h('i', { class: `sw c${sr.cls}` }), sr.name)))
      : null;
    return h('div', { class: 'chart' }, legend, svg);
  }

  window.Charts = { lineChart, niceTicks };
})();
