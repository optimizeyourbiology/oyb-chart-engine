/*
 * OYB Chart Engine
 * Canonical renderer for the WordPress charts (bar / line / spd / flicker).
 *
 * Deploy path:  edit THIS file  ->  commit to GitHub  ->  served via jsDelivr
 *               ->  enqueued by the [oyb_chart] PHP shortcode (in WPCode).
 *
 * IMPORTANT: This is now the single source of truth for the chart JS.
 * Do NOT edit the chart JavaScript in WPCode anymore — that snippet gets deleted
 * once this is live. Edit here, push, done.
 *
 * v1.0.0 — verbatim parity port of the existing WPCode JS. No behavior changes.
 *          Improvements (SPD two-mode, etc.) land as later commits.
 */

document.addEventListener("DOMContentLoaded", function() {

    // Find all chart containers on the page
    const chartContainers = document.querySelectorAll('.oyb-chart-container');
    if (chartContainers.length === 0) return;

    // Helper to decode Base64 safely
    function decodeBase64(str) {
        try {
            return decodeURIComponent(atob(str).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
        } catch (e) {
            return atob(str); // Fallback
        }
    }

    // Helper to calculate RGB from Wavelength
    function nmToRGB(wl) {
        let r=0, g=0, b=0;
        if (wl>=380 && wl<440) { r = -(wl-440)/(440-380); b = 1.0; }
        else if (wl>=440 && wl<490) { g = (wl-440)/(490-440); b = 1.0; }
        else if (wl>=490 && wl<510) { g = 1.0; b = -(wl-510)/(510-490); }
        else if (wl>=510 && wl<580) { r = (wl-510)/(580-510); g = 1.0; }
        else if (wl>=580 && wl<645) { r = 1.0; g = -(wl-645)/(645-580); }
        else if (wl>=645 && wl<=780) { r = 1.0; }
        let factor = 1.0;
        if (wl>=380 && wl<420) factor = 0.3 + 0.7*(wl-380)/(420-380);
        else if (wl>=701 && wl<=780) factor = 0.3 + 0.7*(780-wl)/(780-700);
        else if (wl < 380) factor = 0.1;
        else if (wl > 780) factor = 0.1;
        return `rgb(${Math.round(r*factor*255)}, ${Math.round(g*factor*255)}, ${Math.round(b*factor*255)})`;
    }

    // Standard Brand Colors (pink first as the default/featured color)
    const oybColors = ['#FA4488', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0f172a', '#06b6d4', '#84cc16', '#f97316'];
    // Two-dataset color pair (pink + blue)
    const twoDatasetColors = ['#FA4488', '#3b82f6'];
    // Neutral pill colors (used when pill is unpinned)
    const PILL_NEUTRAL_BORDER = '#cbd5e1';
    const PILL_NEUTRAL_TEXT   = '#64748b';

    // Axis styling shared across all chart types
    const AXIS_LABEL_COLOR = '#64748b';
    const AXIS_TICK_COLOR  = '#64748b';
    const AXIS_GRID_COLOR  = '#f1f5f9';
    const AXIS_TITLE_FONT = {
        family: 'Nunito',
        weight: '700',
        size: 12
    };
    const formatAxisTitle = (label) => (label || '').toUpperCase();
    const AXIS_TITLE_PADDING = { top: 10, bottom: 4 };

    // Opacity levels applied to line stroke based on focus state
    const FOCUS_DEFAULT_ALPHA   = 0.35; // All lines at rest (nothing pinned, nothing hovered)
    const FOCUS_HIGHLIGHT_ALPHA = 1.0;  // Pinned or hovered line
    const FOCUS_FADED_ALPHA     = 0.08; // Lines that are neither pinned nor hovered when something else is

    // Hard-coded axis labels for fixed-meaning chart types
    const FIXED_AXIS_LABELS = {
        spd:     { x: 'Wavelength (nm)', y: 'Relative Intensity' },
        flicker: { x: 'Time (seconds)',  y: 'Light Output' }
    };

    // Helper: convert hex color to rgba with alpha
    function hexToRgba(hex, alpha) {
        const h = hex.replace('#', '');
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // Mobile detection (matches the 768px breakpoint in the PHP CSS)
    const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

    // Repaint all datasets based on the current set of pinned + hovered indices.
    //   - If pinnedSet is empty AND hoveredIndex < 0: all lines at FOCUS_DEFAULT_ALPHA
    //   - If pinnedSet is empty AND a hover exists: hovered at HIGHLIGHT, rest stay at DEFAULT
    //   - Otherwise (pins exist): highlighted = pinned ∪ {hovered}; everything else fades
    function applyFocus(chartInstance, pinnedSet, hoveredIndex) {
        const hasPins  = pinnedSet.size > 0;
        const hasHover = hoveredIndex >= 0;
        chartInstance.data.datasets.forEach((ds, i) => {
            if (!ds._sourceHex) return;
            let alpha;
            if (!hasPins && !hasHover) {
                alpha = FOCUS_DEFAULT_ALPHA;
            } else if (!hasPins && hasHover) {
                alpha = (i === hoveredIndex) ? FOCUS_HIGHLIGHT_ALPHA : FOCUS_DEFAULT_ALPHA;
            } else if (pinnedSet.has(i) || i === hoveredIndex) {
                alpha = FOCUS_HIGHLIGHT_ALPHA;
            } else {
                alpha = FOCUS_FADED_ALPHA;
            }
            ds.borderColor = hexToRgba(ds._sourceHex, alpha);
        });
        chartInstance.update('none');
    }

    // Build a pill for a multi-dataset chart with pin-on-click and preview-on-hover behavior.
    // Shares a `pinnedSet` across all pills in the same chart.
    function buildPill(chartInstance, pinnedSet, refreshAllPills, ds, index) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.textContent = ds.label;
        pill.dataset.datasetIndex = index;

        const color = ds._sourceHex || ds.borderColor;
        const fadedColor = hexToRgba(color, 0.35);

        // Repaint just THIS pill based on its current pinned state and hover state.
        const applyStyle = (pinned, hovered) => {
            const shadowColor = hexToRgba(color, 0.35);
            // Inactive pills show their line color faded so they're identifiable on mobile.
            // Hover or pin brings them to full color.
            const active = pinned || hovered;
            const borderColor = active ? color : fadedColor;
            const textColor   = pinned ? '#ffffff' : (hovered ? color : fadedColor);
            const bgColor     = pinned ? color : 'transparent';
            Object.assign(pill.style, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                border: `2px solid ${borderColor}`,
                borderRadius: '999px',
                background: bgColor,
                color: textColor,
                fontFamily: "'Nunito', sans-serif",
                fontWeight: '700',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                opacity: '1',
                boxShadow: hovered && pinned ? `0 4px 12px ${shadowColor}` : 'none',
                outline: 'none',
                transform: hovered ? 'translateY(-1px)' : 'translateY(0)'
            });
        };

        // Expose the repaint method so the parent can refresh pills when pins change elsewhere
        pill._refresh = (hovered) => applyStyle(pinnedSet.has(index), hovered || false);

        // Initial render: nothing pinned, not hovered
        applyStyle(false, false);

        // Click: toggle this index in the pinned set, then repaint everything
        pill.addEventListener('click', () => {
            if (pinnedSet.has(index)) {
                pinnedSet.delete(index);
            } else {
                pinnedSet.add(index);
            }
            refreshAllPills();
            applyFocus(chartInstance, pinnedSet, index); // index is currently hovered too
        });

        // Hover: preview this dataset (in addition to anything already pinned)
        pill.addEventListener('mouseenter', () => {
            applyStyle(pinnedSet.has(index), true);
            applyFocus(chartInstance, pinnedSet, index);
        });
        pill.addEventListener('mouseleave', () => {
            applyStyle(pinnedSet.has(index), false);
            applyFocus(chartInstance, pinnedSet, -1);
        });
        pill.addEventListener('focus', () => {
            applyStyle(pinnedSet.has(index), true);
            applyFocus(chartInstance, pinnedSet, index);
        });
        pill.addEventListener('blur', () => {
            applyStyle(pinnedSet.has(index), false);
            applyFocus(chartInstance, pinnedSet, -1);
        });

        return pill;
    }

    // Loop through each chart container and draw it
    chartContainers.forEach(container => {
        const canvas = container.querySelector('canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const chartType = container.getAttribute('data-type');
        const fixed = FIXED_AXIS_LABELS[chartType];
        const customXLabel = fixed ? fixed.x : container.getAttribute('data-x');
        const customYLabel = fixed ? fixed.y : container.getAttribute('data-y');
        const rawCsv = decodeBase64(container.getAttribute('data-csv'));
        if (!rawCsv.trim()) return;

        // --- 1. PARSE CSV ---
        const rows = rawCsv.trim().split(/\r?\n/).filter(row => row.trim() !== '');
        const headers = rows[0].split(/,|\t/).map(h => h.trim());
        let xLabels = [];
        const datasets = [];
        for (let i = 1; i < headers.length; i++) {
            datasets.push({ label: headers[i], data: [] });
        }
        for (let i = 1; i < rows.length; i++) {
            const cols = rows[i].split(/,|\t/);
            if (cols.length >= 2) {
                xLabels.push(cols[0].trim());
                for (let j = 1; j < cols.length; j++) {
                    let val = parseFloat(cols[j].trim());
                    datasets[j-1].data.push(isNaN(val) ? null : val);
                }
            }
        }

        let chartConfig = {};

        // --- 2. APPLY TEMPLATES ---
        if (chartType === 'spd') {
            let spdData = datasets[0].data;
            const maxVal = Math.max(...spdData);
            if (maxVal > 0) spdData = spdData.map(v => v / maxVal);

            xLabels = spdData.map((_, i) => 380 + i);
            const startNM = 380;
            const endNM = startNM + spdData.length - 1;
            chartConfig = {
                type: 'line',
                data: {
                    labels: xLabels,
                    datasets: [{
                        data: spdData,
                        borderColor: 'transparent',
                        borderWidth: 0,
                        fill: true,
                        pointRadius: 0,
                        tension: 0.1,
                        backgroundColor: function(context) {
                            const chartArea = context.chart.chartArea;
                            if (!chartArea) return 'rgba(0,0,0,0.1)';
                            const gradient = ctx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
                            const getPos = nm => Math.max(0, Math.min(1, (nm - startNM) / (endNM - startNM)));
                            gradient.addColorStop(0, "rgba(75, 0, 130, 1)");
                            gradient.addColorStop(getPos(450), "rgba(0, 0, 255, 1)");
                            gradient.addColorStop(getPos(490), "rgba(0, 255, 255, 1)");
                            gradient.addColorStop(getPos(530), "rgba(0, 255, 0, 1)");
                            gradient.addColorStop(getPos(580), "rgba(255, 255, 0, 1)");
                            gradient.addColorStop(getPos(620), "rgba(255, 127, 0, 1)");
                            gradient.addColorStop(getPos(700), "rgba(255, 0, 0, 1)");
                            gradient.addColorStop(1, "rgba(100, 0, 0, 1)");
                            return gradient;
                        }
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            enabled: false,
                            external: function(context) {
                                let tooltipEl = document.getElementById('chartjs-spd-tooltip');
                                if (!tooltipEl) {
                                    tooltipEl = document.createElement('div');
                                    tooltipEl.id = 'chartjs-spd-tooltip';
                                    tooltipEl.innerHTML = `
                                        <div style="font-weight: 800; font-size: 14px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
                                            <span id="spd-tt-title"></span>
                                            <span id="spd-tt-dot" style="width: 12px; height: 12px; border-radius: 50%; box-shadow: 0 0 4px rgba(0,0,0,0.5);"></span>
                                        </div>
                                        <div style="font-size: 11px; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">Intensity</div>
                                        <div style="display: flex; align-items: center; gap: 10px;">
                                            <div style="flex-grow: 1; background: #334155; height: 6px; border-radius: 3px; overflow: hidden; width: 100px;">
                                                <div id="spd-tt-bar" style="height: 100%; border-radius: 3px; transition: width 0.1s ease;"></div>
                                            </div>
                                            <span id="spd-tt-val" style="font-weight: 700; font-size: 13px;"></span>
                                        </div>
                                        <div style="position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 8px solid #1e293b;"></div>
                                    `;

                                    Object.assign(tooltipEl.style, {
                                        opacity: 0,
                                        position: 'absolute',
                                        background: '#1e293b',
                                        color: '#ffffff',
                                        borderRadius: '12px',
                                        padding: '12px',
                                        pointerEvents: 'none',
                                        transform: 'translate(-50%, calc(-100% - 15px))',
                                        transition: 'opacity 0.1s ease, top 0.1s ease, left 0.1s ease',
                                        boxShadow: '0 10px 25px rgba(0,0,0,0.3)',
                                        zIndex: 1000,
                                        minWidth: '150px',
                                        fontFamily: "'Nunito', sans-serif"
                                    });
                                    document.body.appendChild(tooltipEl);
                                }
                                const tooltipModel = context.tooltip;
                                if (tooltipModel.opacity === 0) {
                                    tooltipEl.style.opacity = 0;
                                    return;
                                }
                                if (tooltipModel.body) {
                                    const dataIndex = tooltipModel.dataPoints[0].dataIndex;
                                    const wl = xLabels[dataIndex];

                                    let intensity = spdData[dataIndex] * 100;
                                    intensity = Math.max(0, Math.min(100, intensity));

                                    const wlColor = nmToRGB(wl);
                                    tooltipEl.querySelector('#spd-tt-title').innerText = wl + ' nm';
                                    tooltipEl.querySelector('#spd-tt-val').innerText = intensity.toFixed(1) + '%';

                                    tooltipEl.querySelector('#spd-tt-dot').style.backgroundColor = wlColor;
                                    tooltipEl.querySelector('#spd-tt-bar').style.width = intensity + '%';
                                    tooltipEl.querySelector('#spd-tt-bar').style.backgroundColor = wlColor;
                                }
                                const position = context.chart.canvas.getBoundingClientRect();
                                tooltipEl.style.opacity = 1;
                                tooltipEl.style.left = position.left + window.scrollX + tooltipModel.caretX + 'px';
                                tooltipEl.style.top = position.top + window.scrollY + tooltipModel.caretY + 'px';
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: { display: true, text: formatAxisTitle(customXLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            grid: { display: false },
                            ticks: {
                                color: AXIS_TICK_COLOR,
                                callback: function(val, index) {
                                    const nm = xLabels[index];
                                    return nm % 20 === 0 ? nm : null;
                                }
                            }
                        },
                        y: {
                            min: 0, max: 1.0,
                            display: false
                        }
                    }
                }
            };
        }

        else if (chartType === 'flicker') {
            const datasetCount = datasets.length;

            let palette;
            if (datasetCount === 2) {
                palette = twoDatasetColors;
            } else {
                palette = oybColors;
            }
            const flickerBorderWidth = isMobile() ? 1 : 1.5;
            const useFocusMode = datasetCount >= 3;
            datasets.forEach((ds, index) => {
                const color = palette[index % palette.length];
                ds._sourceHex = color;
                ds.borderColor = useFocusMode ? hexToRgba(color, FOCUS_DEFAULT_ALPHA) : color;
                ds.backgroundColor = color;
                ds.fill = false;
                ds.borderWidth = flickerBorderWidth;
                ds.pointRadius = 0;
                ds.pointHoverRadius = 0;
                ds.pointBackgroundColor = color;
                ds.pointBorderColor = color;
                ds.tension = 0.1;
                let xyData = [];
                for (let k = 0; k < ds.data.length; k++) {
                    if (ds.data[k] !== null && ds.data[k] !== undefined && !isNaN(parseFloat(xLabels[k]))) {
                        xyData.push({ x: parseFloat(xLabels[k]), y: ds.data[k] });
                    }
                }
                ds.data = xyData;
            });

            // Legend rules:
            //   1 dataset  -> no legend
            //   2 datasets -> native Chart.js legend
            //   3+         -> hide native legend, use custom pills
            let showNativeLegend;
            if (datasetCount === 1) showNativeLegend = false;
            else if (datasetCount === 2) showNativeLegend = true;
            else showNativeLegend = false;

            chartConfig = {
                type: 'line',
                data: { datasets: datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'nearest', axis: 'x', intersect: false },
                    plugins: {
                        legend: {
                            display: showNativeLegend,
                            position: 'top',
                            labels: {
                                font: { family: 'Nunito', weight: '700' },
                                usePointStyle: true,
                                pointStyle: 'circle',
                                boxPadding: 6,
                                padding: 16
                            }
                        },
                        tooltip: {
                            enabled: false
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            min: 0,
                            max: 0.1,
                            title: { display: true, text: formatAxisTitle(customXLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            grid: { display: false },
                            ticks: {
                                color: AXIS_TICK_COLOR,
                                stepSize: 0.01,
                                callback: function(value) {
                                    return Number(value.toFixed(2)) + 's';
                                }
                            }
                        },
                        y: {
                            min: 0,
                            max: 1,
                            title: { display: true, text: formatAxisTitle(customYLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            grid: { color: AXIS_GRID_COLOR },
                            ticks: {
                                color: AXIS_TICK_COLOR,
                                stepSize: 0.2,
                                callback: function(value) {
                                    return Math.round(value * 100) + '%';
                                }
                            }
                        }
                    }
                }
            };
        }
        else if (chartType === 'line') {
            const datasetCount = datasets.length;
            const lineBorderWidth = isMobile() ? 2.5 : 3.5;
            const useFocusMode = datasetCount >= 2;
            datasets.forEach((ds, index) => {
                const color = oybColors[index % oybColors.length];
                ds._sourceHex = color;
                ds.borderColor = useFocusMode ? hexToRgba(color, FOCUS_DEFAULT_ALPHA) : color;
                ds.backgroundColor = color;
                ds.fill = false;
                ds.borderWidth = lineBorderWidth;
                ds.borderCapStyle = 'round';
                ds.borderJoinStyle = 'round';
                ds.pointRadius = 0;
                ds.pointHoverRadius = 0;
                ds.tension = 0.3;
            });
            chartConfig = {
                type: 'line',
                data: { labels: xLabels, datasets: datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            enabled: false
                        }
                    },
                    scales: {
                        x: {
                            title: { display: !!customXLabel, text: formatAxisTitle(customXLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            grid: { display: false },
                            ticks: { color: AXIS_TICK_COLOR }
                        },
                        y: {
                            beginAtZero: true,
                            title: { display: !!customYLabel, text: formatAxisTitle(customYLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            grid: { color: AXIS_GRID_COLOR },
                            ticks: { color: AXIS_TICK_COLOR }
                        }
                    }
                }
            };
        }
        else if (chartType === 'bar') {
            datasets.forEach((ds, index) => {
                ds.backgroundColor = '#9999B3';
                ds.hoverBackgroundColor = '#FA4488';
                ds.borderRadius = 8;
                ds.borderSkipped = 'bottom';
            });
            chartConfig = {
                type: 'bar',
                data: { labels: xLabels, datasets: datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: '#1D293B', displayColors: false, padding: 12,
                            titleColor: '#94a3b8', titleFont: { family: 'Nunito', weight: '800' },
                            bodyFont: { family: 'Nunito', size: 15, weight: '800' },
                            callbacks: {
                                title: context => (context[0].label || '').toUpperCase(),
                                label: context => context.parsed.y + ' ' + (customYLabel ? customYLabel.toLowerCase() : context.dataset.label.toLowerCase())
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: { display: !!customXLabel, text: formatAxisTitle(customXLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            grid: { display: false },
                            ticks: { color: AXIS_TICK_COLOR }
                        },
                        y: {
                            title: { display: !!customYLabel, text: formatAxisTitle(customYLabel), font: AXIS_TITLE_FONT, color: AXIS_LABEL_COLOR, padding: AXIS_TITLE_PADDING },
                            beginAtZero: true,
                            grid: { color: AXIS_GRID_COLOR },
                            ticks: { color: AXIS_TICK_COLOR }
                        }
                    }
                }
            };
        }

        // --- 3. DRAW ---
        if (Object.keys(chartConfig).length !== 0) {
            const chartInstance = new Chart(ctx, chartConfig);

            // --- 4. BUILD PILL CONTROLS with pin-on-click + preview-on-hover ---
            let shouldBuildPills = false;
            if (chartType === 'flicker' && datasets.length >= 3) shouldBuildPills = true;
            else if (chartType === 'line' && datasets.length >= 2) shouldBuildPills = true;

            if (shouldBuildPills) {
                const pinnedSet = new Set();
                const pills = [];
                // Called when pin state changes so every pill can repaint its border/fill
                const refreshAllPills = () => {
                    pills.forEach(p => p._refresh(false));
                };
                const pillContainer = document.createElement('div');
                pillContainer.className = 'oyb-chart-pills';
                Object.assign(pillContainer.style, {
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                    marginBottom: '16px',
                    fontFamily: "'Nunito', sans-serif"
                });
                datasets.forEach((ds, index) => {
                    const pill = buildPill(chartInstance, pinnedSet, refreshAllPills, ds, index);
                    pills.push(pill);
                    pillContainer.appendChild(pill);
                });
                container.parentNode.insertBefore(pillContainer, container);
            }
        }
    });
});
