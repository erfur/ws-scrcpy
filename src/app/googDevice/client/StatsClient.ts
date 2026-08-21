import '../../../style/stats.css';
import { ManagerClient } from '../../client/ManagerClient';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import {
    STATS_RETENTION_MS,
    STATS_SAMPLE_INTERVAL_MS,
    STATS_SERIES,
    StatsMessage,
    StatsSample,
    StatsSeries,
    StatsUnit,
} from '../../../common/Stats';
import { ParamsStats } from '../../../types/ParamsStats';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import Util from '../../Util';

const TAG = '[StatsClient]';
const SVG_NS = 'http://www.w3.org/2000/svg';

// Categorical palette validated for the white card surface (CVD-safe in this
// order). One fixed slot per series key: a series keeps its color no matter which
// other series have data or are muted.
const SERIES_COLORS: Record<string, string> = {
    battery: '#2a78d6',
    cpu: '#eb6834',
    gpu: '#1baf7a',
    skin: '#eda100',
    modem: '#e87ba4',
    level: '#008300',
};
const FALLBACK_COLOR = '#898781';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

type TimeRange = { label: string; title: string; ms: number };
const RANGES: TimeRange[] = [
    { label: '15m', title: 'Last 15 minutes', ms: 15 * MINUTE },
    { label: '1h', title: 'Last hour', ms: HOUR },
    { label: '6h', title: 'Last 6 hours', ms: 6 * HOUR },
    { label: '24h', title: 'Last 24 hours', ms: 24 * HOUR },
];
const DEFAULT_RANGE_INDEX = 1;

const X_TICK_STEPS = [
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    4 * HOUR,
    6 * HOUR,
];
const MAX_X_TICKS = 8;
const MARGIN = { top: 18, right: 18, bottom: 30, left: 46 };
// vertical space between stacked plots (room for the lower plot's unit label)
const PLOT_GAP = 28;
// above this many visible samples the drawn paths are decimated (hover still uses every sample)
const MAX_PATH_POINTS = 3000;
const MAX_TABLE_ROWS = 500;

// Per-unit plot settings. Units share the x-axis but never a y-axis.
type UnitSpec = {
    // relative height among the stacked plots
    weight: number;
    tickSteps: number[];
    maxTicks: number;
    // domain used when no data is visible
    fallback: [number, number];
    // hard bounds the auto domain never exceeds
    clamp?: [number, number];
    // decimals shown in legend/tooltip
    decimals: number;
};
const UNIT_SPECS: Record<StatsUnit, UnitSpec> = {
    '°C': { weight: 3, tickSteps: [1, 2, 5, 10, 20, 50], maxTicks: 6, fallback: [20, 60], decimals: 1 },
    '%': {
        weight: 1.4,
        tickSteps: [1, 2, 5, 10, 20, 25, 50],
        maxTicks: 4,
        fallback: [0, 100],
        clamp: [0, 100],
        decimals: 0,
    },
};

type Plot = {
    unit: StatsUnit;
    spec: UnitSpec;
    seriesIndexes: number[];
    top: number;
    bottom: number;
    yMin: number;
    yMax: number;
};

type Scale = {
    left: number;
    right: number;
    plotLeft: number;
    plotRight: number;
    plotTop: number;
    plotBottom: number;
    plots: Plot[];
};

export class StatsClient extends ManagerClient<ParamsStats, never> {
    public static readonly ACTION = ACTION.STATS;

    public static start(params: ParamsStats): StatsClient {
        return new StatsClient(params);
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        if (descriptor.state !== 'device') {
            return;
        }
        const entry = document.createElement('div');
        entry.classList.add('stats', blockClass);
        entry.appendChild(
            BaseDeviceTracker.buildLink(
                {
                    action: ACTION.STATS,
                    udid: descriptor.udid,
                },
                'stats',
                params,
            ),
        );
        return entry;
    }

    public static parseParameters(params: URLSearchParams): ParamsStats {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STATS) {
            throw Error('Incorrect action');
        }
        return { ...typedParams, action, udid: Util.parseString(params, 'udid', true) };
    }

    private readonly udid: string;
    private readonly name: string;

    private series: StatsSeries[] = STATS_SERIES.slice();
    private samples: StatsSample[] = [];
    private intervalMs = STATS_SAMPLE_INTERVAL_MS;
    private retentionMs = STATS_RETENTION_MS;
    private rangeIndex = DEFAULT_RANGE_INDEX;
    private readonly mutedSeries: Set<number> = new Set();
    private historyLoaded = false;
    private connectionLost = false;
    private tableVisible = false;
    private renderScheduled = false;
    private scale?: Scale;
    private visible: StatsSample[] = [];

    private readonly wrapper: HTMLElement;
    private readonly statusEl: HTMLElement;
    private readonly rangeButtons: HTMLButtonElement[] = [];
    private readonly tableToggle: HTMLButtonElement;
    private readonly chartEl: HTMLElement;
    private readonly svg: SVGSVGElement;
    private readonly emptyEl: HTMLElement;
    private readonly tooltipEl: HTMLElement;
    private readonly legendEl: HTMLElement;
    private readonly tableWrapper: HTMLElement;
    private readonly tableEl: HTMLTableElement;
    private readonly tableNote: HTMLElement;
    private hoverGroup?: SVGGElement;
    private resizeObserver?: ResizeObserver;
    private clockTimer?: number;

    constructor(params: ParamsStats) {
        super(params);
        this.udid = params.udid;
        this.name = `${TAG} [${this.udid}]`;
        this.setTitle(`Stats ${this.udid}`);
        this.setBodyClass('stats');

        this.wrapper = document.createElement('div');
        this.wrapper.className = 'stats-wrapper';

        // toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'stats-toolbar';
        const ranges = document.createElement('div');
        ranges.className = 'stats-ranges';
        ranges.setAttribute('role', 'group');
        ranges.setAttribute('aria-label', 'Time range');
        RANGES.forEach((range, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.innerText = range.label;
            button.title = range.title;
            button.onclick = () => {
                this.setRange(index);
            };
            ranges.appendChild(button);
            this.rangeButtons.push(button);
        });
        toolbar.appendChild(ranges);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'stats-status';
        toolbar.appendChild(this.statusEl);
        this.tableToggle = document.createElement('button');
        this.tableToggle.type = 'button';
        this.tableToggle.className = 'stats-table-toggle';
        this.tableToggle.innerText = 'table';
        this.tableToggle.title = 'Show the samples of the selected range as a table';
        this.tableToggle.setAttribute('aria-pressed', 'false');
        this.tableToggle.onclick = () => {
            this.setTableVisible(!this.tableVisible);
        };
        toolbar.appendChild(this.tableToggle);
        this.wrapper.appendChild(toolbar);

        // chart card
        const card = document.createElement('div');
        card.className = 'stats-card';
        this.chartEl = document.createElement('div');
        this.chartEl.className = 'stats-chart';
        this.svg = document.createElementNS(SVG_NS, 'svg');
        this.svg.setAttribute('role', 'img');
        this.svg.setAttribute('aria-label', `Stats history of ${this.udid}`);
        this.chartEl.appendChild(this.svg);
        this.emptyEl = document.createElement('div');
        this.emptyEl.className = 'stats-empty';
        this.chartEl.appendChild(this.emptyEl);
        this.tooltipEl = document.createElement('div');
        this.tooltipEl.className = 'stats-tooltip tooltip-hidden';
        this.chartEl.appendChild(this.tooltipEl);
        card.appendChild(this.chartEl);
        this.legendEl = document.createElement('div');
        this.legendEl.className = 'stats-legend';
        card.appendChild(this.legendEl);
        this.wrapper.appendChild(card);

        // table twin
        this.tableWrapper = document.createElement('div');
        this.tableWrapper.className = 'stats-table-wrapper table-hidden';
        this.tableEl = document.createElement('table');
        this.tableEl.className = 'stats-table';
        this.tableWrapper.appendChild(this.tableEl);
        this.tableNote = document.createElement('div');
        this.tableNote.className = 'stats-table-note';
        this.tableWrapper.appendChild(this.tableNote);
        this.wrapper.appendChild(this.tableWrapper);

        this.mountPoint.appendChild(this.wrapper);

        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => {
                this.scheduleRender();
            });
            this.resizeObserver.observe(this.chartEl);
        } else {
            window.addEventListener('resize', this.scheduleRender);
        }
        // keep the window sliding even while no sample arrives (e.g. device offline)
        this.clockTimer = window.setInterval(this.scheduleRender, this.intervalMs);

        this.updateRangeButtons();
        this.scheduleRender();
        this.openNewConnection();
    }

    // ---- ManagerClient ----

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelInitData(): Buffer {
        const udid = Util.stringToUtf8ByteArray(this.udid);
        const buffer = Buffer.alloc(4 + 4 + udid.byteLength);
        buffer.write(ChannelCode.STAT, 'ascii');
        buffer.writeUInt32LE(udid.length, 4);
        buffer.set(udid, 8);
        return buffer;
    }

    protected onSocketOpen(): void {
        this.connectionLost = false;
        this.scheduleRender();
    }

    protected onSocketMessage(event: MessageEvent): void {
        let message: StatsMessage;
        try {
            message = JSON.parse(event.data);
        } catch (error: any) {
            console.error(this.name, `Failed to parse message: ${error.message}`);
            return;
        }
        switch (message.type) {
            case 'history': {
                const { series, samples, intervalMs, retentionMs } = message.data;
                if (Array.isArray(series) && series.length) {
                    this.series = series;
                }
                if (Array.isArray(samples)) {
                    this.samples = samples;
                }
                if (intervalMs > 0) {
                    this.intervalMs = intervalMs;
                }
                if (retentionMs > 0) {
                    this.retentionMs = retentionMs;
                }
                this.historyLoaded = true;
                break;
            }
            case 'sample': {
                const sample = message.data;
                if (!Array.isArray(sample) || typeof sample[0] !== 'number') {
                    return;
                }
                this.samples.push(sample);
                this.trimSamples(sample[0] - this.retentionMs);
                break;
            }
            default:
                console.error(this.name, `Unknown message type`, message);
                return;
        }
        this.scheduleRender();
    }

    protected onSocketClose(event: CloseEvent): void {
        if (this.destroyed) {
            return;
        }
        console.error(this.name, 'socket closed', event.reason);
        this.connectionLost = true;
        this.scheduleRender();
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        } else {
            window.removeEventListener('resize', this.scheduleRender);
        }
        if (this.clockTimer) {
            window.clearInterval(this.clockTimer);
            this.clockTimer = undefined;
        }
        super.destroy();
    }

    // ---- state ----

    private setRange(index: number): void {
        if (index === this.rangeIndex || !RANGES[index]) {
            return;
        }
        this.rangeIndex = index;
        this.updateRangeButtons();
        this.hideTooltip();
        this.scheduleRender();
    }

    private updateRangeButtons(): void {
        this.rangeButtons.forEach((button, index) => {
            const active = index === this.rangeIndex;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    private setTableVisible(visible: boolean): void {
        this.tableVisible = visible;
        this.tableToggle.classList.toggle('active', visible);
        this.tableToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
        this.tableWrapper.classList.toggle('table-hidden', !visible);
        this.scheduleRender();
    }

    private toggleSeries(index: number): void {
        if (this.mutedSeries.has(index)) {
            this.mutedSeries.delete(index);
        } else {
            this.mutedSeries.add(index);
        }
        this.hideTooltip();
        this.scheduleRender();
    }

    private trimSamples(cutoff: number): void {
        let expired = 0;
        while (expired < this.samples.length && this.samples[expired][0] < cutoff) {
            expired++;
        }
        if (expired) {
            this.samples.splice(0, expired);
        }
    }

    private scheduleRender = (): void => {
        if (this.renderScheduled || this.destroyed) {
            return;
        }
        this.renderScheduled = true;
        window.requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.render();
        });
    };

    // ---- rendering ----

    private render(): void {
        const range = RANGES[this.rangeIndex];
        const right = Date.now();
        const left = right - range.ms;
        // include one sample before the window so the lines enter from the edge
        let start = this.lowerBound(left);
        if (start > 0) {
            start--;
        }
        this.visible = this.samples.slice(start);

        this.renderStatus();
        this.renderLegend();
        this.renderChart(left, right);
        if (this.tableVisible) {
            this.renderTable(left);
        }
    }

    private renderStatus(): void {
        let text: string;
        let lost = false;
        if (this.connectionLost) {
            text = 'connection lost';
            lost = true;
        } else if (!this.historyLoaded) {
            text = 'loading…';
        } else {
            const inRange = this.visible.length;
            text = `${inRange} sample${inRange === 1 ? '' : 's'} · live, every ${Math.round(this.intervalMs / 1000)}s`;
        }
        this.statusEl.innerText = text;
        this.statusEl.classList.toggle('lost', lost);
    }

    private renderLegend(): void {
        this.legendEl.innerHTML = '';
        this.series.forEach((series, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'stats-legend-item';
            item.title = `${series.description}. Click to ${this.mutedSeries.has(index) ? 'show' : 'hide'}.`;
            const muted = this.mutedSeries.has(index);
            item.classList.toggle('muted-series', muted);
            item.setAttribute('aria-pressed', muted ? 'false' : 'true');
            const key = document.createElement('span');
            key.className = 'legend-key';
            key.style.background = this.colorOf(series);
            item.appendChild(key);
            const label = document.createElement('span');
            label.className = 'legend-label';
            label.textContent = series.label;
            item.appendChild(label);
            const value = document.createElement('span');
            value.className = 'legend-value';
            const latest = this.latestValue(index);
            if (latest === null) {
                value.textContent = '—';
                item.classList.add('no-data');
            } else {
                value.textContent = StatsClient.formatValue(latest, series.unit);
            }
            item.appendChild(value);
            item.onclick = () => {
                this.toggleSeries(index);
            };
            this.legendEl.appendChild(item);
        });
    }

    // One plot per unit, in order of first appearance among the series.
    private buildPlots(plotTop: number, plotBottom: number): Plot[] {
        const plots: Plot[] = [];
        this.series.forEach((series, index) => {
            let plot = plots.find((item) => item.unit === series.unit);
            if (!plot) {
                const spec = UNIT_SPECS[series.unit] || UNIT_SPECS['°C'];
                plot = { unit: series.unit, spec, seriesIndexes: [], top: 0, bottom: 0, yMin: 0, yMax: 1 };
                plots.push(plot);
            }
            plot.seriesIndexes.push(index);
        });
        const totalWeight = plots.reduce((sum, plot) => sum + plot.spec.weight, 0);
        const available = plotBottom - plotTop - PLOT_GAP * (plots.length - 1);
        let cursor = plotTop;
        plots.forEach((plot) => {
            plot.top = cursor;
            plot.bottom = cursor + (available * plot.spec.weight) / totalWeight;
            cursor = plot.bottom + PLOT_GAP;
            this.computeDomain(plot);
        });
        return plots;
    }

    private computeDomain(plot: Plot): void {
        const { spec } = plot;
        let min = Infinity;
        let max = -Infinity;
        this.visible.forEach((sample) => {
            plot.seriesIndexes.forEach((index) => {
                if (this.mutedSeries.has(index)) {
                    return;
                }
                const value = sample[index + 1];
                if (typeof value === 'number') {
                    if (value < min) {
                        min = value;
                    }
                    if (value > max) {
                        max = value;
                    }
                }
            });
        });
        if (min === Infinity) {
            [min, max] = spec.fallback;
        }
        const span = Math.max(max - min, 1) + 2;
        let step = spec.tickSteps[spec.tickSteps.length - 1];
        for (const candidate of spec.tickSteps) {
            if (span / candidate <= spec.maxTicks) {
                step = candidate;
                break;
            }
        }
        let yMin = Math.floor((min - 1) / step) * step;
        let yMax = Math.ceil((max + 1) / step) * step;
        if (spec.clamp) {
            yMin = Math.max(yMin, spec.clamp[0]);
            yMax = Math.min(yMax, spec.clamp[1]);
        }
        if (yMax <= yMin) {
            yMax = yMin + step;
        }
        plot.yMin = yMin;
        plot.yMax = yMax;
        // stash the step for the tick loop
        (plot as Plot & { step: number }).step = step;
    }

    private renderChart(left: number, right: number): void {
        const width = this.chartEl.clientWidth;
        const height = this.chartEl.clientHeight;
        this.svg.innerHTML = '';
        this.hoverGroup = undefined;
        if (!width || !height) {
            return;
        }
        this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        this.svg.setAttribute('width', `${width}`);
        this.svg.setAttribute('height', `${height}`);

        const plotLeft = MARGIN.left;
        const plotRight = Math.max(plotLeft + 10, width - MARGIN.right);
        const plotTop = MARGIN.top;
        const plotBottom = Math.max(plotTop + 10, height - MARGIN.bottom);
        const plots = this.buildPlots(plotTop, plotBottom);
        const scale: Scale = { left, right, plotLeft, plotRight, plotTop, plotBottom, plots };
        this.scale = scale;

        let hasData = false;

        // x ticks (local clock), aligned to round multiples of the step
        let xStep = X_TICK_STEPS[X_TICK_STEPS.length - 1];
        for (const step of X_TICK_STEPS) {
            if ((right - left) / step <= MAX_X_TICKS) {
                xStep = step;
                break;
            }
        }
        const tzOffset = new Date().getTimezoneOffset() * MINUTE;
        const firstTick = Math.ceil((left - tzOffset) / xStep) * xStep + tzOffset;

        plots.forEach((plot, plotIndex) => {
            const step = (plot as Plot & { step: number }).step;
            const isLast = plotIndex === plots.length - 1;

            // unit label
            const unitLabel = StatsClient.svgElement('text', {
                class: 'stat-plot-label',
                x: plotLeft,
                y: plot.top - 6,
            });
            unitLabel.textContent = plot.unit;
            this.svg.appendChild(unitLabel);

            // horizontal grid + y ticks
            for (let value = plot.yMin; value <= plot.yMax + 1e-9; value += step) {
                const y = this.sy(plot, value);
                this.svg.appendChild(
                    StatsClient.svgElement('line', {
                        class: 'stat-grid',
                        x1: plotLeft,
                        x2: plotRight,
                        y1: y,
                        y2: y,
                    }),
                );
                const label = StatsClient.svgElement('text', {
                    class: 'stat-tick',
                    x: plotLeft - 8,
                    y: y + 4,
                    'text-anchor': 'end',
                });
                label.textContent = StatsClient.formatTick(value, plot.unit);
                this.svg.appendChild(label);
            }

            // x tick marks on every plot's baseline; labels only under the last one
            for (let tick = firstTick; tick <= right; tick += xStep) {
                const x = this.sx(tick);
                this.svg.appendChild(
                    StatsClient.svgElement('line', {
                        class: 'stat-axis',
                        x1: x,
                        x2: x,
                        y1: plot.bottom,
                        y2: plot.bottom + 4,
                    }),
                );
                if (isLast) {
                    const label = StatsClient.svgElement('text', {
                        class: 'stat-tick',
                        x,
                        y: plot.bottom + 18,
                        'text-anchor': 'middle',
                    });
                    label.textContent = StatsClient.formatClock(tick);
                    this.svg.appendChild(label);
                }
            }
            this.svg.appendChild(
                StatsClient.svgElement('line', {
                    class: 'stat-axis',
                    x1: plotLeft,
                    x2: plotRight,
                    y1: plot.bottom,
                    y2: plot.bottom,
                }),
            );

            // series lines (decimated when dense) + end markers with a surface ring
            const stride = Math.max(1, Math.ceil(this.visible.length / MAX_PATH_POINTS));
            const gapMs = this.intervalMs * 3 * stride;
            plot.seriesIndexes.forEach((index) => {
                if (this.mutedSeries.has(index)) {
                    return;
                }
                const color = this.colorOf(this.series[index]);
                let d = '';
                let previousTime = -Infinity;
                let lastPoint: { x: number; y: number } | undefined;
                for (let i = 0; i < this.visible.length; i += stride) {
                    const sample = this.visible[i];
                    const value = sample[index + 1];
                    if (typeof value !== 'number') {
                        previousTime = -Infinity;
                        continue;
                    }
                    const x = this.sx(sample[0]);
                    const y = this.sy(plot, value);
                    const command = sample[0] - previousTime > gapMs ? 'M' : 'L';
                    d += `${command}${x.toFixed(1)} ${y.toFixed(1)}`;
                    previousTime = sample[0];
                    if (sample[0] <= right) {
                        lastPoint = { x, y };
                    }
                }
                if (!d) {
                    return;
                }
                hasData = true;
                this.svg.appendChild(
                    StatsClient.svgElement('path', {
                        class: 'stat-line',
                        d,
                        stroke: color,
                    }),
                );
                if (lastPoint) {
                    this.svg.appendChild(
                        StatsClient.svgElement('circle', {
                            class: 'stat-marker',
                            cx: lastPoint.x,
                            cy: lastPoint.y,
                            r: 4,
                            fill: color,
                        }),
                    );
                }
            });
        });

        // hover layer spans every plot: one crosshair, one readout
        const hover = StatsClient.svgElement('g') as SVGGElement;
        this.hoverGroup = hover;
        this.svg.appendChild(hover);
        const target = StatsClient.svgElement('rect', {
            class: 'stat-hover-target',
            x: plotLeft,
            y: plotTop,
            width: plotRight - plotLeft,
            height: plotBottom - plotTop,
        });
        target.addEventListener('pointermove', this.onPointerMove);
        target.addEventListener('pointerleave', this.hideTooltip);
        this.svg.appendChild(target);

        let emptyText = '';
        if (!hasData) {
            if (this.connectionLost) {
                emptyText = 'connection lost';
            } else if (!this.historyLoaded) {
                emptyText = 'loading history…';
            } else if (this.samples.length) {
                emptyText = `no samples in the last ${RANGES[this.rangeIndex].title.replace(/^Last /, '')}`;
            } else {
                emptyText = 'waiting for the first sample…';
            }
        }
        this.emptyEl.innerText = emptyText;
    }

    private renderTable(left: number): void {
        this.tableEl.innerHTML = '';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const timeHead = document.createElement('th');
        timeHead.textContent = 'Time';
        headRow.appendChild(timeHead);
        this.series.forEach((series) => {
            const th = document.createElement('th');
            th.textContent = `${series.label} ${series.unit}`;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        this.tableEl.appendChild(thead);

        const tbody = document.createElement('tbody');
        const inRange = this.visible.filter((sample) => sample[0] >= left);
        const rows = inRange.slice(Math.max(0, inRange.length - MAX_TABLE_ROWS)).reverse();
        rows.forEach((sample) => {
            const tr = document.createElement('tr');
            const timeCell = document.createElement('td');
            timeCell.textContent = StatsClient.formatDateTime(sample[0]);
            tr.appendChild(timeCell);
            this.series.forEach((series, index) => {
                const td = document.createElement('td');
                const value = sample[index + 1];
                if (typeof value === 'number') {
                    td.textContent = value.toFixed(StatsClient.decimalsOf(series.unit));
                } else {
                    td.textContent = '—';
                    td.classList.add('no-value');
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        this.tableEl.appendChild(tbody);
        if (!inRange.length) {
            this.tableNote.innerText = 'no samples in the selected range';
        } else if (inRange.length > rows.length) {
            this.tableNote.innerText = `showing the latest ${rows.length} of ${inRange.length} samples`;
        } else {
            this.tableNote.innerText = `${rows.length} samples, newest first`;
        }
    }

    // ---- hover ----

    private onPointerMove = (event: PointerEvent): void => {
        const scale = this.scale;
        if (!scale || !this.hoverGroup || !this.visible.length) {
            return;
        }
        const rect = this.svg.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const ratio = (px - scale.plotLeft) / (scale.plotRight - scale.plotLeft);
        const time = scale.left + ratio * (scale.right - scale.left);
        const sample = this.nearestSample(time);
        if (!sample) {
            return;
        }
        const x = this.sx(sample[0]);

        this.hoverGroup.innerHTML = '';
        this.hoverGroup.appendChild(
            StatsClient.svgElement('line', {
                class: 'stat-crosshair',
                x1: x,
                x2: x,
                y1: scale.plotTop,
                y2: scale.plotBottom,
            }),
        );
        this.tooltipEl.innerHTML = '';
        const timeEl = document.createElement('div');
        timeEl.className = 'tip-time';
        timeEl.textContent = StatsClient.formatDateTime(sample[0]);
        this.tooltipEl.appendChild(timeEl);
        scale.plots.forEach((plot) => {
            plot.seriesIndexes.forEach((index) => {
                if (this.mutedSeries.has(index)) {
                    return;
                }
                const series = this.series[index];
                const value = sample[index + 1];
                const color = this.colorOf(series);
                if (typeof value === 'number') {
                    this.hoverGroup?.appendChild(
                        StatsClient.svgElement('circle', {
                            class: 'stat-marker',
                            cx: x,
                            cy: this.sy(plot, value),
                            r: 4,
                            fill: color,
                        }),
                    );
                }
                const row = document.createElement('div');
                row.className = 'tip-row';
                const key = document.createElement('span');
                key.className = 'tip-key';
                key.style.background = color;
                row.appendChild(key);
                const valueEl = document.createElement('span');
                valueEl.className = 'tip-value';
                valueEl.textContent = typeof value === 'number' ? StatsClient.formatValue(value, series.unit) : '—';
                row.appendChild(valueEl);
                const label = document.createElement('span');
                label.className = 'tip-label';
                label.textContent = series.label;
                row.appendChild(label);
                this.tooltipEl.appendChild(row);
            });
        });
        this.tooltipEl.classList.remove('tooltip-hidden');

        // keep the readout inside the chart, flipping sides near the right edge
        const tipWidth = this.tooltipEl.offsetWidth;
        const tipHeight = this.tooltipEl.offsetHeight;
        let tipLeft = x + 14;
        if (tipLeft + tipWidth > rect.width) {
            tipLeft = x - 14 - tipWidth;
        }
        let tipTop = event.clientY - rect.top - tipHeight / 2;
        tipTop = Math.max(0, Math.min(tipTop, rect.height - tipHeight));
        this.tooltipEl.style.left = `${Math.max(0, tipLeft)}px`;
        this.tooltipEl.style.top = `${tipTop}px`;
    };

    private hideTooltip = (): void => {
        this.tooltipEl.classList.add('tooltip-hidden');
        if (this.hoverGroup) {
            this.hoverGroup.innerHTML = '';
        }
    };

    // ---- helpers ----

    private sx(time: number): number {
        const { left, right, plotLeft, plotRight } = this.scale as Scale;
        return plotLeft + ((time - left) / (right - left)) * (plotRight - plotLeft);
    }

    private sy(plot: Plot, value: number): number {
        return plot.bottom - ((value - plot.yMin) / (plot.yMax - plot.yMin)) * (plot.bottom - plot.top);
    }

    private colorOf(series: StatsSeries): string {
        return SERIES_COLORS[series.key] || FALLBACK_COLOR;
    }

    private latestValue(index: number): number | null {
        for (let i = this.samples.length - 1; i >= 0; i--) {
            const value = this.samples[i][index + 1];
            if (typeof value === 'number') {
                return value;
            }
        }
        return null;
    }

    // index of the first sample at or after `time`
    private lowerBound(time: number): number {
        let low = 0;
        let high = this.samples.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (this.samples[mid][0] < time) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    private nearestSample(time: number): StatsSample | undefined {
        const list = this.visible;
        if (!list.length) {
            return;
        }
        let low = 0;
        let high = list.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (list[mid][0] < time) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if (low === 0) {
            return list[0];
        }
        if (low >= list.length) {
            return list[list.length - 1];
        }
        const before = list[low - 1];
        const after = list[low];
        return time - before[0] <= after[0] - time ? before : after;
    }

    private static svgElement(tag: string, attributes: Record<string, string | number> = {}): SVGElement {
        const element = document.createElementNS(SVG_NS, tag);
        Object.keys(attributes).forEach((name) => {
            element.setAttribute(name, `${attributes[name]}`);
        });
        return element;
    }

    private static pad2(value: number): string {
        return value < 10 ? `0${value}` : `${value}`;
    }

    private static formatClock(time: number): string {
        const date = new Date(time);
        return `${StatsClient.pad2(date.getHours())}:${StatsClient.pad2(date.getMinutes())}`;
    }

    private static formatDateTime(time: number): string {
        const date = new Date(time);
        const day = `${date.getFullYear()}-${StatsClient.pad2(date.getMonth() + 1)}-${StatsClient.pad2(
            date.getDate(),
        )}`;
        return `${day} ${StatsClient.formatClock(time)}:${StatsClient.pad2(date.getSeconds())}`;
    }

    private static decimalsOf(unit: StatsUnit): number {
        return (UNIT_SPECS[unit] || UNIT_SPECS['°C']).decimals;
    }

    private static formatValue(value: number, unit: StatsUnit): string {
        const text = value.toFixed(StatsClient.decimalsOf(unit));
        return unit === '%' ? `${text}%` : `${text}°`;
    }

    private static formatTick(value: number, unit: StatsUnit): string {
        return unit === '%' ? `${value}%` : `${value}°`;
    }
}
