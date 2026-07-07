/*
 * OYB Chart Engine — v1.1.13
 * Canonical renderer for the WordPress charts.
 * Types: bar · line · spd · flicker · flicker_risk
 *
 * Deploy: edit here -> commit to github.com/optimizeyourbiology/oyb-chart-engine
 *         -> publish release tag vX.Y.Z -> bump the @version in the WPCode PHP enqueue.
 * Do NOT put chart JS back in WPCode (that is the WAF trap).
 *
 * Reads container attributes emitted by the [oyb_chart] shortcode:
 *   data-type, data-x, data-y, data-csv (base64),
 *   data-highlight, data-units, data-distance, data-nonvisual,
 *   data-flicker-percent, data-flicker-frequency
 */
document.addEventListener('DOMContentLoaded', function () {
  var containers = document.querySelectorAll('.oyb-chart-container');
  if (!containers.length) return;

  // Neutralize the theme's default button hover/focus (Kadence adds a blue halo) on our control pills/toggles.
  if (!document.getElementById('oyb-chart-style')) {
    var _st = document.createElement('style');
    _st.id = 'oyb-chart-style';
    _st.textContent = '.oyb-chart-controls button{box-shadow:none !important;outline:none !important;background-image:none !important;text-shadow:none !important;}.oyb-chart-controls button:hover,.oyb-chart-controls button:focus{box-shadow:none !important;outline:none !important;background-image:none !important;filter:none !important;}';
    document.head.appendChild(_st);
  }

  // ---------- palette / style ----------
  var PINK = '#FA4488', BLUE = '#3b82f6', GREEN = '#10b981', AMBER = '#f59e0b', RED = '#dc2626', GREY = '#9999B3';
  var OYB = [PINK, BLUE, GREEN, AMBER, '#ef4444', '#8b5cf6', '#0f172a', '#06b6d4', '#84cc16', '#f97316'];
  var GHOST = 'rgba(148,163,184,0.20)';
  // built from char codes so the source stays pure ASCII and can't mojibake on the CDN -> renders "µW/cm²/nm"
  var SPD_ABS_UNITS = String.fromCharCode(181) + 'W/cm' + String.fromCharCode(178) + '/nm';
  var AXIS_COLOR = '#64748b', TICK_COLOR = '#64748b', GRID_COLOR = '#f1f5f9', NAVY = '#1d293b';
  var AXIS_TITLE_FONT = { family: 'Nunito', weight: '700', size: 12 };
  var TITLE_PAD = { top: 10, bottom: 4 };
  var FOCUS_DEFAULT = 0.35, FOCUS_HI = 1.0, FOCUS_FADE = 0.08;
  var FIXED_AXIS = { spd: { x: 'Wavelength (nm)', y: 'Relative Intensity' }, flicker: { x: 'Time (seconds)', y: 'Light Output' } };
  var upper = function (s) { return (s || '').toUpperCase(); };

  // melanopic action spectrum (CIE S 026), 380..780 step 5, peak-normalized, cleaned
  var MEL = [0.00118,0.00212,0.00388,0.00728,0.014,0.0275,0.055,0.0936,0.16,0.215,0.289,0.36,0.446,0.521,0.602,0.677,0.753,0.826,0.895,0.945,0.984,0.999,0.998,0.98,0.945,0.893,0.827,0.746,0.658,0.568,0.479,0.395,0.318,0.25,0.192,0.143,0.103,0.073,0.0504,0.034,0.0227,0.0149,0.00977,0.00636,0.00413,0.00268,0.00175,0.00114,0.00075,0.00049,0.00032,0.00022,0.00014,0.0001,0.00007,0.00004,0.00003,0.00002,0.00001,0.00001,0.00001,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  var MEL_NM = MEL.map(function (_, i) { return 380 + i * 5; });

  // ---------- helpers ----------
  function decodeBase64(str) {
    try {
      return decodeURIComponent(atob(str).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
    } catch (e) { return atob(str); }
  }
  function hexToRgba(hex, alpha) {
    var h = hex.replace('#', '');
    return 'rgba(' + parseInt(h.substr(0, 2), 16) + ',' + parseInt(h.substr(2, 2), 16) + ',' + parseInt(h.substr(4, 2), 16) + ',' + alpha + ')';
  }
  function nmToRGB(wl) {
    var r = 0, g = 0, b = 0;
    if (wl >= 380 && wl < 440) { r = -(wl - 440) / 60; b = 1; }
    else if (wl >= 440 && wl < 490) { g = (wl - 440) / 50; b = 1; }
    else if (wl >= 490 && wl < 510) { g = 1; b = -(wl - 510) / 20; }
    else if (wl >= 510 && wl < 580) { r = (wl - 510) / 70; g = 1; }
    else if (wl >= 580 && wl < 645) { r = 1; g = -(wl - 645) / 65; }
    else if (wl >= 645 && wl <= 780) { r = 1; }
    var f = 1;
    if (wl >= 380 && wl < 420) f = 0.3 + 0.7 * (wl - 380) / 40;
    else if (wl >= 701 && wl <= 780) f = 0.3 + 0.7 * (780 - wl) / 80;
    else if (wl < 380 || wl > 780) f = 0.1;
    return 'rgb(' + Math.round(r * f * 255) + ',' + Math.round(g * f * 255) + ',' + Math.round(b * f * 255) + ')';
  }
  var isMobile = function () { return window.matchMedia('(max-width: 768px)').matches; };

  function parseCSV(raw) {
    var rows = raw.trim().split(/\r?\n/).filter(function (r) { return r.trim() !== ''; });
    var headers = rows[0].split(/,|\t/).map(function (h) { return h.trim(); });
    var xLabels = [], datasets = [];
    for (var i = 1; i < headers.length; i++) datasets.push({ label: headers[i], data: [] });
    for (var r = 1; r < rows.length; r++) {
      var cols = rows[r].split(/,|\t/);
      if (cols.length < 2) continue;
      xLabels.push(cols[0].trim());
      for (var j = 1; j < cols.length; j++) {
        var v = parseFloat(cols[j].trim());
        datasets[j - 1].data.push(isNaN(v) ? null : v);
      }
    }
    return { headers: headers, xLabels: xLabels, datasets: datasets };
  }

  // hero list from data-highlight (comma-separated labels, case-insensitive)
  function heroList(attr) {
    if (!attr) return [];
    return attr.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }
  function heroColorOf(label, heroes, fallback) {
    var i = heroes.indexOf((label || '').trim().toLowerCase());
    if (i === 0) return PINK;
    if (i === 1) return BLUE;
    if (i > 1) return OYB[i % OYB.length];
    return fallback;
  }

  // ---------- shared UI ----------
  function makeControls(container) {
    var bar = document.createElement('div');
    bar.className = 'oyb-chart-controls';
    bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:18px;font-family:Nunito,sans-serif;';
    container.parentNode.insertBefore(bar, container);
    return bar;
  }
  function paintToggle(b, on) {
    // slate (not pink) so view-mode toggles never look like a colored data-series pill
    b.style.background = on ? '#334155' : '#fff';
    b.style.borderColor = on ? '#334155' : '#e2b9c7';
    b.style.color = on ? '#fff' : '#64748b';
  }
  function toggleBtn(label, on) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.style.cssText = 'font-family:inherit;font-weight:800;font-size:12px;border:2px solid #e2b9c7;border-radius:999px;padding:5px 12px;cursor:pointer;';
    paintToggle(b, !!on);
    return b;
  }
  // Shared series-pill look (used by line, SPD, flicker-risk so legends are consistent)
  function stylePill(btn, color, active) {
    var faded = hexToRgba(color, 0.4);
    btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-family:Nunito,sans-serif;font-weight:700;font-size:13px;cursor:pointer;transition:all .15s ease;border:2px solid ' + (active ? color : faded) + ';background:' + (active ? color : 'transparent') + ';color:' + (active ? '#fff' : faded) + ';';
  }

  var AXIS_TITLE = function (text) {
    return { display: !!text, text: upper(text), font: AXIS_TITLE_FONT, color: AXIS_COLOR, padding: TITLE_PAD };
  };
  // Adaptive SPD wavelength axis. Anchors to the visible band (380-780) and extends outward only as far
  // as there is real UV/IR signal (>= 1% of peak), snapped to a tidy 20 nm boundary. A pure-visible SPD
  // stays 380-780; a red+IR pulse-ox or a UVB lamp stretches to include its invisible peak.
  function spdRange(nm, ys) {
    var peak = 0, i, v;
    for (i = 0; i < ys.length; i++) { v = Math.abs(ys[i] || 0); if (v > peak) peak = v; }
    var thr = peak * 0.01, lo = Infinity, hi = -Infinity;
    for (i = 0; i < nm.length; i++) {
      if (isNaN(nm[i])) continue;
      if (Math.abs(ys[i] || 0) >= thr) { if (nm[i] < lo) lo = nm[i]; if (nm[i] > hi) hi = nm[i]; }
    }
    if (!isFinite(lo)) { lo = 380; hi = 780; }
    lo = Math.min(380, Math.floor((lo - 10) / 20) * 20);
    hi = Math.max(780, Math.ceil((hi + 10) / 20) * 20);
    return { min: Math.max(200, lo), max: Math.min(1100, hi) };
  }
  // Round ticks across whatever range the axis ended up spanning (50 nm for narrow, 100 nm for wide).
  function spdTicksFor(min, max) {
    return function (scale) {
      var step = (max - min) <= 450 ? 50 : 100, ticks = [], t = Math.ceil(min / step) * step;
      for (; t <= max + 1e-6; t += step) ticks.push({ value: t });
      scale.ticks = ticks;
    };
  }
  // The melanopic overlay is a circadian/visual-light lens, so it only belongs on lights whose PURPOSE is
  // visual. That's not something the spectrum can tell us — a pulse-ox emits visible red/blue against skin,
  // never toward an eye — so the operator declares it per chart via the `non_visual` meta (data-nonvisual).
  // Default (empty) = visual light -> melanopic shown (unchanged for every existing lamp chart);
  // truthy -> hide (pulse-ox, UV, IR-therapy, and any non-visual emitter).
  function melAllowed(o) {
    // Robust to however the JetEngine checkbox stores its value: empty/false-ish = visual (show melanopic);
    // any other non-empty value (1, true, yes, on, a checkbox's own label, ...) = non-visual (hide).
    var v = ((o && o.nonvisual) || '').toString().trim().toLowerCase();
    return v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off';
  }

  // ---------- plugins ----------
  var valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw: function (chart) {
      if (!chart.$valueLabels) return;
      var ctx = chart.ctx, horiz = chart.options.indexAxis === 'y', unit = chart.$valueUnit || '';
      ctx.save(); ctx.font = "800 12px Nunito"; ctx.fillStyle = '#475569';
      chart.data.datasets.forEach(function (ds, di) {
        chart.getDatasetMeta(di).data.forEach(function (el, i) {
          var v = ds.data[i]; if (v == null) return;
          if (horiz) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(v + unit, el.x + 8, el.y); }
          else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(v + unit, el.x, el.y - 6); }
        });
      });
      ctx.restore();
    }
  };

  var melLayer = {
    id: 'melLayer',
    afterDatasetsDraw: function (chart) {
      if (!chart.$showMel) return;
      var xs = chart.scales.x, ys = chart.scales.y, ctx = chart.ctx, a = chart.chartArea, s = chart.$melScale || 1;
      ctx.save();
      ctx.beginPath(); ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); ctx.clip();
      ctx.beginPath();
      MEL_NM.forEach(function (nm, i) { var px = xs.getPixelForValue(nm), py = ys.getPixelForValue(MEL[i] * s); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.lineTo(xs.getPixelForValue(MEL_NM[MEL_NM.length - 1]), ys.getPixelForValue(0));
      ctx.lineTo(xs.getPixelForValue(MEL_NM[0]), ys.getPixelForValue(0));
      ctx.closePath(); ctx.fillStyle = 'rgba(15,23,42,0.06)'; ctx.fill();
      ctx.beginPath();
      MEL_NM.forEach(function (nm, i) { var px = xs.getPixelForValue(nm), py = ys.getPixelForValue(MEL[i] * s); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(15,23,42,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }
  };

  // ---------- SPD tooltips (ported) ----------
  function spdTipEl() {
    var el = document.getElementById('oyb-spd-tip'); if (el) return el;
    el = document.createElement('div'); el.id = 'oyb-spd-tip';
    el.innerHTML = '<div style="font-weight:800;font-size:15px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;gap:24px;"><span class="t"></span><span class="d" style="width:12px;height:12px;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.5);"></span></div><div style="font-size:11px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;font-weight:800;letter-spacing:.5px;">Intensity</div><div style="display:flex;align-items:center;gap:10px;"><div style="flex-grow:1;background:#334155;height:6px;border-radius:3px;overflow:hidden;width:120px;"><div class="b" style="height:100%;border-radius:3px;transition:width .1s ease;"></div></div><span class="v" style="font-weight:800;font-size:13px;"></span></div><div style="position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:8px solid #1e293b;"></div>';
    el.style.cssText = 'opacity:0;position:absolute;background:#1e293b;color:#fff;border-radius:12px;padding:12px 14px;pointer-events:none;transform:translate(-50%,calc(-100% - 15px));transition:opacity .1s ease,top .1s ease,left .1s ease;box-shadow:0 10px 25px rgba(0,0,0,0.3);z-index:1000;min-width:170px;font-family:Nunito,sans-serif;';
    document.body.appendChild(el); return el;
  }
  function segmented(labels, active, onPick) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-flex;border:2px solid #cbd5e1;border-radius:999px;overflow:hidden;font-family:Nunito,sans-serif;';
    var btns = [];
    labels.forEach(function (lab, i) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = lab;
      b.style.cssText = 'font-family:inherit;font-weight:800;font-size:12px;border:none;padding:5px 14px;cursor:pointer;background:' + (i === active ? '#334155' : '#fff') + ';color:' + (i === active ? '#fff' : '#64748b') + ';';
      b.onclick = function () { active = i; btns.forEach(function (bb, j) { bb.style.background = j === i ? '#334155' : '#fff'; bb.style.color = j === i ? '#fff' : '#64748b'; }); onPick(i); };
      wrap.appendChild(b); btns.push(b);
    });
    return wrap;
  }
  function spdSingleTip(ctx) {
    var el = spdTipEl(), tt = ctx.tooltip; if (tt.opacity === 0) { el.style.opacity = 0; return; }
    var dp = (tt.dataPoints || [])[0]; if (!dp) return;
    var ch = ctx.chart, wl = Math.round(dp.parsed.x), yv = dp.parsed.y, c = nmToRGB(wl), bar, val;
    if (ch.$absolute) { var mx = ch.$yMax || 1; bar = Math.max(0, Math.min(100, yv / mx * 100)); val = Number(yv.toPrecision(3)) + ' ' + SPD_ABS_UNITS; }
    else { bar = Math.max(0, Math.min(100, yv * 100)); val = bar.toFixed(1) + '%'; }
    el.querySelector('.t').innerText = wl + ' nm';
    el.querySelector('.v').innerText = val;
    el.querySelector('.d').style.backgroundColor = c;
    el.querySelector('.b').style.width = bar + '%';
    el.querySelector('.b').style.backgroundColor = c;
    var pos = ctx.chart.canvas.getBoundingClientRect();
    el.style.opacity = 1; el.style.left = pos.left + window.scrollX + tt.caretX + 'px'; el.style.top = pos.top + window.scrollY + tt.caretY + 'px';
  }
  function multiTipEl() {
    var el = document.getElementById('oyb-multi-tip'); if (el) return el;
    el = document.createElement('div'); el.id = 'oyb-multi-tip';
    el.style.cssText = 'opacity:0;position:absolute;background:#1e293b;color:#fff;border-radius:12px;padding:12px 14px;pointer-events:none;transform:translate(-50%,calc(-100% - 15px));transition:opacity .1s ease,top .1s ease,left .1s ease;box-shadow:0 10px 25px rgba(0,0,0,0.3);z-index:1000;min-width:180px;font-family:Nunito,sans-serif;';
    document.body.appendChild(el); return el;
  }
  function makeMultiTip(fmt, unitLabel) {
    return function (ctx) {
      var el = multiTipEl(), tt = ctx.tooltip; if (tt.opacity === 0) { el.style.opacity = 0; return; }
      var pts = tt.dataPoints || []; if (!pts.length) return;
      var head = fmt(pts[0].parsed.x);
      var rows = pts.map(function (p) {
        var v = unitLabel(p);
        return '<div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:5px;"><span style="width:10px;height:10px;border-radius:50%;background:' + p.dataset.borderColor + '"></span><span style="flex:1;padding-right:14px;">' + p.dataset.label + '</span><b>' + v + '</b></div>';
      }).join('');
      el.innerHTML = '<div style="font-weight:800;font-size:15px;">' + head + '</div>' + rows;
      var pos = ctx.chart.canvas.getBoundingClientRect();
      el.style.opacity = 1; el.style.left = pos.left + window.scrollX + tt.caretX + 'px'; el.style.top = pos.top + window.scrollY + tt.caretY + 'px';
    };
  }

  // ---------- focus + pills (line) ----------
  function applyFocus(chart, pinned, hovered) {
    var hasPins = pinned.size > 0, hasHover = hovered >= 0;
    chart.data.datasets.forEach(function (ds, i) {
      if (!ds._hex) return;
      var alpha;
      if (!hasPins && !hasHover) alpha = FOCUS_DEFAULT;
      else if (!hasPins && hasHover) alpha = (i === hovered) ? FOCUS_HI : FOCUS_DEFAULT;
      else if (pinned.has(i) || i === hovered) alpha = FOCUS_HI;
      else alpha = FOCUS_FADE;
      ds.borderColor = hexToRgba(ds._hex, alpha);
    });
    chart.update('none');
  }
  function buildPill(chart, pinned, refresh, ds, index) {
    var pill = document.createElement('button');
    pill.type = 'button'; pill.textContent = ds.label;
    var color = ds._hex || ds.borderColor, faded = hexToRgba(color, 0.35);
    function style(p, h) {
      var active = p || h;
      Object.assign(pill.style, {
        display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px',
        border: '2px solid ' + (active ? color : faded), borderRadius: '999px',
        background: p ? color : 'transparent', color: p ? '#fff' : (h ? color : faded),
        fontFamily: 'Nunito, sans-serif', fontWeight: '700', fontSize: '13px', cursor: 'pointer',
        transition: 'all .15s ease', transform: h ? 'translateY(-1px)' : 'translateY(0)'
      });
    }
    pill._refresh = function (h) { style(pinned.has(index), h || false); };
    style(false, false);
    pill.addEventListener('click', function () { pinned.has(index) ? pinned.delete(index) : pinned.add(index); refresh(); applyFocus(chart, pinned, index); });
    pill.addEventListener('mouseenter', function () { style(pinned.has(index), true); applyFocus(chart, pinned, index); });
    pill.addEventListener('mouseleave', function () { style(pinned.has(index), false); applyFocus(chart, pinned, -1); });
    return pill;
  }

  // ---------- IEEE 1789 ----------
  function ieeeNo(f) { return Math.min(100, f < 90 ? 0.01 * f : 0.0333 * f); }
  function ieeeLow(f) { return Math.min(100, Math.max(0.2, f < 90 ? 0.025 * f : 0.08 * f)); }
  function ieeeClamp(v) { return Math.max(0.05, Math.min(100, v)); }
  function ieeeCurve(fn) {
    var p = [], f;
    for (f = 1; f < 90; f *= 1.15) p.push({ x: f, y: ieeeClamp(fn(f)) });
    p.push({ x: 89.99, y: ieeeClamp(fn(89.99)) });
    for (f = 90; f < 10000; f *= 1.15) p.push({ x: f, y: ieeeClamp(fn(f)) });
    p.push({ x: 10000, y: ieeeClamp(fn(10000)) });
    return p;
  }
  function ieeeVerdict(pct, freq) {
    if (!freq || isNaN(freq)) return null;
    if (pct <= ieeeNo(freq)) return { t: 'No risk', c: GREEN };
    if (pct <= ieeeLow(freq)) return { t: 'Low risk', c: AMBER };
    return { t: 'High risk', c: RED };
  }
  var ieeeLabelsPlugin = {
    id: 'ieeeLabels',
    afterDatasetsDraw: function (chart) {
      var xs = chart.scales.x, ys = chart.scales.y, ctx = chart.ctx;
      function halo(w) { ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.fillRect(-w / 2 - 5, -2, w + 10, 17); }
      function along(fn, text, color, fA, fB) {
        var x1 = xs.getPixelForValue(fA), y1 = ys.getPixelForValue(fn(fA)), x2 = xs.getPixelForValue(fB), y2 = ys.getPixelForValue(fn(fB));
        ctx.save(); ctx.translate((x1 + x2) / 2, (y1 + y2) / 2); ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
        ctx.font = "800 12px Nunito"; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        halo(ctx.measureText(text).width);
        ctx.fillStyle = color; ctx.fillText(text, 0, 1); ctx.restore();
      }
      along(ieeeLow, 'Low effect limit', AMBER, 120, 320);
      along(ieeeNo, 'No effect limit', GREEN, 700, 2500);
      ctx.save(); ctx.font = "800 13px Nunito"; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.translate(xs.getPixelForValue(14), ys.getPixelForValue(55)); halo(ctx.measureText('High risk').width);
      ctx.fillStyle = RED; ctx.fillText('High risk', 0, 1); ctx.restore();
    }
  };

  // ================= RENDERERS =================

  function renderBar(container, canvas, parsed, o) {
    var labels = parsed.xLabels, ds = parsed.datasets[0] || { data: [] };
    var heroes = heroList(o.highlight);
    var horizontal = labels.length > 6 || isMobile();
    var colors = labels.map(function (l) { return heroColorOf(l, heroes, GREY); });
    var chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: ds.data, backgroundColor: colors, hoverBackgroundColor: PINK, borderRadius: 8, borderSkipped: horizontal ? false : 'bottom' }] },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        responsive: true, maintainAspectRatio: false,
        layout: { padding: horizontal ? { right: 44 } : { top: 22 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { grid: { display: !horizontal ? false : true, color: GRID_COLOR }, ticks: { color: horizontal ? TICK_COLOR : NAVY, font: { weight: '800' }, autoSkip: false, maxRotation: horizontal ? 0 : 60 }, beginAtZero: horizontal, title: AXIS_TITLE(horizontal ? o.y : o.x) },
          y: { grid: { display: horizontal ? false : true, color: GRID_COLOR }, ticks: { color: horizontal ? NAVY : TICK_COLOR, font: { weight: '800' }, autoSkip: false }, beginAtZero: !horizontal, title: AXIS_TITLE(horizontal ? o.x : o.y) }
        }
      },
      plugins: [valueLabels]
    });
    chart.$valueLabels = true; chart.$valueUnit = ''; chart.update();
  }

  function renderLine(container, canvas, parsed, o) {
    var heroes = heroList(o.highlight);
    var count = parsed.datasets.length;
    var focus = count >= 2;
    var lw = isMobile() ? 2.5 : 3.5;
    parsed.datasets.forEach(function (dsi, index) {
      var color = OYB[index % OYB.length];
      dsi._hex = color;
      dsi.borderColor = focus ? hexToRgba(color, FOCUS_DEFAULT) : color;
      dsi.backgroundColor = color; dsi.fill = false; dsi.borderWidth = lw;
      dsi.borderCapStyle = 'round'; dsi.borderJoinStyle = 'round';
      dsi.pointRadius = 0; dsi.pointHoverRadius = 0; dsi.tension = 0.3;
    });
    var chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: parsed.xLabels, datasets: parsed.datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: TICK_COLOR }, title: AXIS_TITLE(o.x) },
          y: { beginAtZero: true, grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR }, title: AXIS_TITLE(o.y) }
        }
      }
    });
    if (focus) {
      var pinned = new Set(), pills = [];
      var refresh = function () { pills.forEach(function (p) { p._refresh(false); }); };
      var bar = makeControls(container);
      parsed.datasets.forEach(function (dsi, i) { var p = buildPill(chart, pinned, refresh, dsi, i); pills.push(p); bar.appendChild(p); });
      // pre-pin heroes
      parsed.datasets.forEach(function (dsi, i) { if (heroes.indexOf((dsi.label || '').toLowerCase()) >= 0) pinned.add(i); });
      if (pinned.size) { refresh(); applyFocus(chart, pinned, -1); }
    }
  }

  function renderSPD(container, canvas, parsed, o) {
    var ctx = canvas.getContext('2d');
    var single = parsed.datasets.length === 1;
    var hasAbsolute = !!o.distance; // distance present => this is a calibrated intensity reading => offer Absolute

    if (single) {
      // single SPD: normalized shape by default; if a distance is set, show real irradiance on a y-axis
      var raw = parsed.datasets[0].data.slice();
      // Use the actual Wavelength column (col 0) as x. Back-compat: if it's missing/non-numeric,
      // fall back to the old assumption of 380 nm @ 1 nm steps.
      var nmS = parsed.xLabels.map(parseFloat);
      if (!(nmS.length === raw.length && nmS.every(function (v) { return !isNaN(v); }))) nmS = raw.map(function (_, i) { return 380 + i; });
      var rng = spdRange(nmS, raw), startNM = rng.min, endNM = rng.max;
      var rawMax = Math.max.apply(null, raw) || 1;
      var absSingle = hasAbsolute;
      var xy = raw.map(function (v, i) { return { x: nmS[i], y: absSingle ? v : v / rawMax }; });
      var chart = new Chart(ctx, {
        type: 'line',
        data: { datasets: [{ label: 'SPD', data: xy, borderColor: 'transparent', borderWidth: 0, fill: true, pointRadius: 0, tension: 0.1, clip: false, backgroundColor: function (c) {
          var area = c.chart.chartArea; if (!area) return 'rgba(0,0,0,0.1)';
          var g = ctx.createLinearGradient(area.left, 0, area.right, 0);
          var span = (endNM - startNM) || 1;
          var pos = function (nm) { return Math.max(0, Math.min(1, (nm - startNM) / span)); };
          var stop = function (nm, col) { g.addColorStop(pos(nm), col); };
          // UV (<380, invisible) violet -> dark; visible spectral; IR (>780, invisible) deep red -> near-black
          if (startNM < 380) stop(startNM, 'rgba(45,0,75,1)');
          stop(380, 'rgba(75,0,130,1)'); stop(450, 'rgba(0,0,255,1)'); stop(490, 'rgba(0,255,255,1)'); stop(530, 'rgba(0,255,0,1)'); stop(580, 'rgba(255,255,0,1)'); stop(620, 'rgba(255,127,0,1)'); stop(700, 'rgba(255,0,0,1)'); stop(780, 'rgba(120,0,0,1)');
          if (endNM > 780) stop(endNM, 'rgba(45,0,0,1)');
          return g;
        } }] },
        options: {
          responsive: true, maintainAspectRatio: false, parsing: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { enabled: false, external: spdSingleTip } },
          scales: {
            x: { type: 'linear', min: startNM, max: endNM, grid: { display: false }, title: AXIS_TITLE(FIXED_AXIS.spd.x), afterBuildTicks: spdTicksFor(startNM, endNM), ticks: { color: TICK_COLOR } },
            y: absSingle
              ? { min: 0, beginAtZero: true, grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR }, title: { display: true, text: SPD_ABS_UNITS, font: AXIS_TITLE_FONT, color: AXIS_COLOR, padding: TITLE_PAD } }
              : { min: 0, max: 1, display: false }
          }
        },
        plugins: [melLayer]
      });
      chart.$absolute = absSingle;
      chart.$yMax = absSingle ? rawMax : 1;
      chart.$melScale = absSingle ? rawMax : 1;
      spdMelToggle(container, chart, o.distance, melAllowed(o));
      return;
    }

    // multi SPD: wavelength column as x, each series a line
    var nm = parsed.xLabels.map(parseFloat);
    var abs = false; // start in shape mode
    var series = parsed.datasets.map(function (dsi, i) {
      var color = OYB[i % OYB.length];
      var raw = dsi.data.map(function (v, k) { return { x: nm[k], y: v }; });
      return { name: dsi.label, color: color, raw: raw, visible: true };
    });
    var chart = new Chart(ctx, {
      type: 'line', data: { datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false, parsing: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false },
          tooltip: { enabled: false, external: makeMultiTip(function (x) { return Math.round(x) + ' nm'; }, function (p) { return abs ? p.parsed.y.toFixed(2) : (p.parsed.y * 100).toFixed(0) + '%'; }) } },
        scales: {
          x: { type: 'linear', min: Math.min.apply(null, nm), max: Math.max.apply(null, nm), grid: { display: false }, title: AXIS_TITLE(FIXED_AXIS.spd.x), afterBuildTicks: spdTicksFor(Math.min.apply(null, nm), Math.max.apply(null, nm)), ticks: { color: TICK_COLOR } },
          y: { min: 0, beginAtZero: true, grid: { color: GRID_COLOR }, title: AXIS_TITLE('') }
        }
      },
      plugins: [melLayer]
    });
    function draw() {
      var yMax = 1;
      if (abs) { yMax = 0; series.forEach(function (s) { s.raw.forEach(function (p) { if (p.y > yMax) yMax = p.y; }); }); }
      chart.data.datasets = series.map(function (s) {
        var data = abs ? s.raw : (function () { var m = 0; s.raw.forEach(function (p) { if (p.y > m) m = p.y; }); m = m || 1; return s.raw.map(function (p) { return { x: p.x, y: p.y / m }; }); })();
        return { label: s.name, data: data, borderColor: s.color, backgroundColor: s.color, borderWidth: 2.5, pointRadius: 0, tension: 0.15, fill: false, clip: false, hidden: !s.visible };
      });
      chart.options.scales.y.max = abs ? yMax : 1;
      chart.options.scales.y.title.display = true;
      chart.options.scales.y.title.text = abs ? SPD_ABS_UNITS : 'NORMALIZED';
      chart.$melScale = abs ? yMax : 1;
      chart.update();
    }
    draw();
    // controls
    var barc = makeControls(container);
    series.forEach(function (s) {
      var p = document.createElement('button'); p.type = 'button'; p.textContent = s.name;
      stylePill(p, s.color, true);
      p.onclick = function () { s.visible = !s.visible; draw(); stylePill(p, s.color, s.visible); };
      barc.appendChild(p);
    });
    var _sep = document.createElement('span'); _sep.style.cssText = 'width:1px;align-self:stretch;min-height:22px;background:#e2d0d6;margin:0 6px;'; barc.appendChild(_sep);
    if (hasAbsolute) { barc.appendChild(segmented(['Normalized', 'Absolute'], 0, function (i) { abs = (i === 1); draw(); })); }
    if (melAllowed(o)) {
      var bMel = toggleBtn('Melanopic', false);
      bMel.onclick = function () { chart.$showMel = !chart.$showMel; paintToggle(bMel, !!chart.$showMel); chart.update(); };
      barc.appendChild(bMel);
    }
    if (o.distance) { var note = document.createElement('span'); note.textContent = 'measured at ' + o.distance; note.style.cssText = 'font-size:12px;color:#94a3b8;font-weight:700;align-self:center;margin-left:4px;'; barc.appendChild(note); }
  }

  function spdMelToggle(container, chart, distance, showMel) {
    if (!showMel && !distance) return; // nothing to show -> no controls bar at all
    var barc = makeControls(container);
    if (showMel) {
      var b = toggleBtn('Melanopic', false);
      b.onclick = function () { chart.$showMel = !chart.$showMel; paintToggle(b, !!chart.$showMel); chart.update(); };
      barc.appendChild(b);
    }
    if (distance) { var note = document.createElement('span'); note.textContent = 'Measured at ' + distance; note.style.cssText = 'font-size:12px;color:#94a3b8;font-weight:700;align-self:center;margin-left:4px;'; barc.appendChild(note); }
  }

  function renderFlicker(container, canvas, parsed, o) {
    var times = parsed.xLabels.map(parseFloat);
    var xmax = Math.max.apply(null, times) || 0.1;
    var single = parsed.datasets.length === 1;

    function pctOf(arr) { var mn = Infinity, mxv = -Infinity; arr.forEach(function (v) { if (v == null) return; if (v < mn) mn = v; if (v > mxv) mxv = v; }); if (!isFinite(mn) || (mxv + mn) === 0) return null; return (mxv - mn) / (mxv + mn) * 100; }
    function xy(arr) { var out = []; for (var k = 0; k < arr.length; k++) { if (arr[k] != null && !isNaN(times[k])) out.push({ x: times[k], y: arr[k] }); } return out; }
    function flickerScales() {
      return {
        x: { type: 'linear', min: 0, max: xmax, grid: { display: false }, title: AXIS_TITLE(FIXED_AXIS.flicker.x), ticks: { color: TICK_COLOR, callback: function (v) { return Number(v.toFixed(3)).toString() + 's'; } } },
        y: { min: 0, max: 1, grid: { color: GRID_COLOR }, title: AXIS_TITLE(FIXED_AXIS.flicker.y), ticks: { color: TICK_COLOR, stepSize: 0.2, callback: function (v) { return Math.round(v * 100) + '%'; } } }
      };
    }

    if (single) {
      new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets: [{ data: xy(parsed.datasets[0].data), borderColor: PINK, backgroundColor: hexToRgba(PINK, 0.18), fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.1 }] },
        options: { responsive: true, maintainAspectRatio: false, parsing: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: flickerScales() }
      });
      // spec chips
      var pct = o.flickerPercent !== '' && o.flickerPercent != null ? parseFloat(o.flickerPercent) : pctOf(parsed.datasets[0].data);
      var freq = o.flickerFrequency !== '' && o.flickerFrequency != null ? parseFloat(o.flickerFrequency) : null;
      var chips = document.createElement('div');
      chips.style.cssText = 'display:flex;gap:10px;margin-top:14px;font-family:Nunito,sans-serif;';
      function chip(k, v, color) {
        return '<div style="flex:1;text-align:center;background:#fff;border:1px solid #f1e3e6;border-radius:12px;padding:8px 14px;"><div style="font-size:11px;font-weight:800;letter-spacing:.4px;color:#94a3b8;text-transform:uppercase;">' + k + '</div><div style="font-size:18px;font-weight:900;color:' + (color || NAVY) + ';">' + v + '</div></div>';
      }
      var html = '';
      if (pct != null && !isNaN(pct)) html += chip('% Flicker', (Math.round(pct * 10) / 10) + '%');
      if (freq != null && !isNaN(freq)) html += chip('Frequency', freq + ' Hz');
      var verdict = (pct != null && freq != null) ? ieeeVerdict(pct, freq) : null;
      if (verdict) html += chip('IEEE 1789', verdict.t, verdict.c);
      chips.innerHTML = html;
      if (html) container.parentNode.insertBefore(chips, container.nextSibling);
      return;
    }

    // multi -> small multiples grid
    container.style.height = 'auto';
    var existing = container.querySelector('canvas'); if (existing) existing.remove();
    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:14px;';
    if (isMobile()) grid.style.gridTemplateColumns = '1fr';
    container.appendChild(grid);
    parsed.datasets.forEach(function (dsi, i) {
      var color = OYB[i % OYB.length];
      var pct = pctOf(dsi.data);
      var tile = document.createElement('div');
      tile.style.cssText = 'background:#fffafa;border:1px solid #f1e3e6;border-radius:12px;padding:9px 9px 5px;min-width:0;';
      tile.innerHTML = '<div style="font-size:11.5px;font-weight:800;color:#334155;display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;"><span>' + dsi.label + '</span><span style="color:#94a3b8;">' + (pct != null ? Math.round(pct) + '%' : '') + '</span></div><div style="position:relative;height:120px;"><canvas></canvas></div>';
      grid.appendChild(tile);
      new Chart(tile.querySelector('canvas').getContext('2d'), {
        type: 'line',
        data: { datasets: [{ data: xy(dsi.data), borderColor: color, backgroundColor: hexToRgba(color, 0.18), fill: true, borderWidth: 1, pointRadius: 0, tension: 0.1 }] },
        options: { responsive: true, maintainAspectRatio: false, parsing: false, plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { type: 'linear', min: 0, max: xmax, ticks: { display: false }, grid: { display: false } }, y: { min: 0, max: 1, ticks: { stepSize: 0.5, font: { size: 9 }, callback: function (v) { return Math.round(v * 100) + '%'; } }, grid: { color: GRID_COLOR } } } }
      });
    });
  }

  function renderFlickerRisk(container, canvas, parsed, o) {
    // rows: Label, Frequency, Modulation  (via chart_data)
    var heroes = heroList(o.highlight);
    var pts = [];
    for (var i = 0; i < parsed.xLabels.length; i++) {
      var label = parsed.xLabels[i];
      var f = parsed.datasets[0] ? parsed.datasets[0].data[i] : null;
      var m = parsed.datasets[1] ? parsed.datasets[1].data[i] : null;
      if (f == null || m == null) continue;
      pts.push({ label: label, f: f, m: m });
    }
    // distinct color per lamp so every point is identifiable: heroes pink/blue, the rest cycle the palette
    var rest = OYB.slice(2), ri = 0;
    pts.forEach(function (p) {
      var h = heroes.indexOf((p.label || '').trim().toLowerCase());
      p.color = h === 0 ? PINK : h === 1 ? BLUE : rest[(ri++) % rest.length];
    });
    var lampDs = pts.map(function (p) {
      return { label: p.label, type: 'scatter', data: [{ x: p.f, y: p.m }], backgroundColor: p.color, borderColor: '#fff', borderWidth: 2, pointRadius: 7, pointHoverRadius: 9 };
    });
    var topLine = ieeeCurve(function () { return 100; });

    function riskTipEl() {
      var el = document.getElementById('oyb-risk-tip'); if (el) return el;
      el = document.createElement('div'); el.id = 'oyb-risk-tip';
      el.style.cssText = 'opacity:0;position:absolute;background:#1e293b;border-radius:12px;padding:11px 14px;pointer-events:none;transform:translate(-50%,calc(-100% - 12px));transition:opacity .1s ease,top .1s ease,left .1s ease;box-shadow:0 10px 25px rgba(0,0,0,0.3);z-index:1000;min-width:160px;font-family:Nunito,sans-serif;';
      document.body.appendChild(el); return el;
    }
    function riskExternal(ctx2) {
      var el = riskTipEl(), tt = ctx2.tooltip;
      if (tt.opacity === 0) { el.style.opacity = 0; return; }
      var dps = (tt.dataPoints || []).filter(function (p) { return !p.chart.data.datasets[p.datasetIndex]._limit; });
      if (!dps.length) return;
      el.innerHTML = dps.map(function (p) {
        var c = p.dataset.backgroundColor;
        return '<div class="oyb-rt-row" style="margin-top:8px;"><div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:14px;color:#fff;line-height:1;"><span style="width:11px;height:11px;border-radius:50%;background:' + c + ';flex:none;"></span>' + p.dataset.label + '</div><div style="font-size:12px;font-weight:700;color:#9fb0c4;margin-left:19px;margin-top:3px;">' + p.parsed.y + '% depth &middot; ' + p.parsed.x + ' Hz</div></div>';
      }).join('');
      if (el.firstChild) el.firstChild.style.marginTop = '0';
      var pos = ctx2.chart.canvas.getBoundingClientRect();
      el.style.opacity = 1; el.style.left = pos.left + window.scrollX + tt.caretX + 'px'; el.style.top = pos.top + window.scrollY + tt.caretY + 'px';
    }
    var zoneKey = { id: 'zoneKey', afterDraw: function (c) {
      var ctx2 = c.ctx, a = c.chartArea, items = [['No risk', GREEN], ['Low risk', AMBER], ['High risk', RED]];
      ctx2.save(); ctx2.font = "800 12px Nunito"; ctx2.textBaseline = 'middle';
      var dot = 11, dotGap = 6, gap = 20;
      var widths = items.map(function (it) { return dot + dotGap + ctx2.measureText(it[0]).width; });
      var total = widths.reduce(function (s, w) { return s + w; }, 0) + gap * (items.length - 1);
      var x = (a.left + a.right) / 2 - total / 2, y = c.height - 13;
      items.forEach(function (it, i) {
        ctx2.fillStyle = it[1]; ctx2.beginPath(); ctx2.arc(x + dot / 2, y, dot / 2, 0, 2 * Math.PI); ctx2.fill();
        ctx2.fillStyle = '#64748b'; ctx2.textAlign = 'left'; ctx2.fillText(it[0], x + dot + dotGap, y);
        x += widths[i] + gap;
      });
      ctx2.restore();
    } };

    var chart = new Chart(canvas.getContext('2d'), {
      type: 'scatter',
      data: { datasets: [
        { label: 'no', _limit: true, type: 'line', data: ieeeCurve(ieeeNo), borderColor: GREEN, borderWidth: 2.5, pointRadius: 0, tension: 0, fill: 'start', backgroundColor: 'rgba(16,185,129,0.13)' },
        { label: 'low', _limit: true, type: 'line', data: ieeeCurve(ieeeLow), borderColor: AMBER, borderWidth: 2.5, pointRadius: 0, tension: 0, fill: '-1', backgroundColor: 'rgba(245,158,11,0.14)' },
        { label: 'top', _limit: true, type: 'line', data: topLine, borderColor: 'transparent', borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(220,38,38,0.10)' }
      ].concat(lampDs) },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { bottom: 34 } },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false, external: riskExternal }
        },
        scales: {
          x: { type: 'logarithmic', min: 1, max: 10000, grid: { color: GRID_COLOR }, title: AXIS_TITLE('Flicker frequency (Hz)') },
          y: { type: 'logarithmic', min: 0.1, max: 100, grid: { color: GRID_COLOR }, title: AXIS_TITLE('Modulation depth (%)'), ticks: { color: TICK_COLOR, callback: function (v) { var l = Math.log10(v); return Math.abs(l - Math.round(l)) < 1e-9 ? (v < 1 ? '0.1' : String(v)) : null; } } }
        }
      },
      plugins: [zoneKey]
    });

    var barc = makeControls(container);
    pts.forEach(function (p, i) {
      var idx = 3 + i;
      var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = p.label;
      stylePill(btn, p.color, true);
      btn.onclick = function () { var vis = !chart.isDatasetVisible(idx); chart.setDatasetVisibility(idx, vis); chart.update(); stylePill(btn, p.color, vis); };
      barc.appendChild(btn);
    });
    // risk-zone key is drawn in-canvas by the zoneKey plugin (tight under the x-axis title)
  }

  // ================= DISPATCH =================
  containers.forEach(function (container) {
    var canvas = container.querySelector('canvas');
    if (!canvas) return;
    var type = (container.getAttribute('data-type') || '').toLowerCase();
    var raw = decodeBase64(container.getAttribute('data-csv') || '');
    if (!raw.trim()) return;
    var fixed = FIXED_AXIS[type];
    var o = {
      x: fixed ? fixed.x : container.getAttribute('data-x'),
      y: fixed ? fixed.y : container.getAttribute('data-y'),
      highlight: container.getAttribute('data-highlight'),
      units: container.getAttribute('data-units'),
      distance: container.getAttribute('data-distance'),
      nonvisual: container.getAttribute('data-nonvisual'),
      flickerPercent: container.getAttribute('data-flicker-percent'),
      flickerFrequency: container.getAttribute('data-flicker-frequency')
    };
    var parsed = parseCSV(raw);
    try {
      if (type === 'bar') renderBar(container, canvas, parsed, o);
      else if (type === 'line') renderLine(container, canvas, parsed, o);
      else if (type === 'spd') renderSPD(container, canvas, parsed, o);
      else if (type === 'flicker') renderFlicker(container, canvas, parsed, o);
      else if (type === 'flicker_risk' || type === 'flicker-risk') renderFlickerRisk(container, canvas, parsed, o);
    } catch (e) {
      if (window.console) console.error('OYB chart render error (' + type + '):', e);
    }
  });
});
