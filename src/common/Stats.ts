// Shared between the browser client (StatsClient) and the server
// (StatsCollector service + StatsHistory middleware).

// How often every connected device is sampled, and how long samples are kept (in memory).
export const STATS_SAMPLE_INTERVAL_MS = 10 * 1000;
export const STATS_RETENTION_MS = 24 * 60 * 60 * 1000;

export type StatsSeriesKey = 'battery' | 'cpu' | 'gpu' | 'skin' | 'modem' | 'level';

export type StatsUnit = '°C' | '%';

export type StatsSeries = {
    key: StatsSeriesKey;
    label: string;
    description: string;
    // series sharing a unit are drawn on the same plot; different units get separate plots
    unit: StatsUnit;
};

// Fixed order: it is also the color slot order on the client, so a series keeps
// its color regardless of which other series happen to have data.
export const STATS_SERIES: ReadonlyArray<StatsSeries> = [
    { key: 'battery', label: 'Battery', description: 'Battery pack temperature (dumpsys battery)', unit: '°C' },
    { key: 'cpu', label: 'CPU', description: 'Hottest CPU thermal zone', unit: '°C' },
    { key: 'gpu', label: 'GPU', description: 'Hottest GPU thermal zone', unit: '°C' },
    { key: 'skin', label: 'Skin', description: 'Hottest skin/surface thermal zone', unit: '°C' },
    { key: 'modem', label: 'Modem', description: 'Hottest modem/RF thermal zone', unit: '°C' },
    { key: 'level', label: 'Battery level', description: 'Battery charge level (dumpsys battery)', unit: '%' },
];

// [timestamp (ms since epoch), ...one value per STATS_SERIES entry (null when unknown)]
export type StatsSample = [number, ...Array<number | null>];

export type StatsHistoryData = {
    udid: string;
    intervalMs: number;
    retentionMs: number;
    series: StatsSeries[];
    samples: StatsSample[];
};

export type StatsHistoryMessage = { id: number; type: 'history'; data: StatsHistoryData };
export type StatsSampleMessage = { id: number; type: 'sample'; data: StatsSample };
export type StatsMessage = StatsHistoryMessage | StatsSampleMessage;
