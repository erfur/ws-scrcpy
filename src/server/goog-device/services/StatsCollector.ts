import { Service } from '../../services/Service';
import { ControlCenter } from './ControlCenter';
import { Device } from '../Device';
import { TypedEmitter } from '../../../common/TypedEmitter';
import { DeviceState } from '../../../common/DeviceState';
import {
    STATS_RETENTION_MS,
    STATS_SAMPLE_INTERVAL_MS,
    STATS_SERIES,
    StatsSample,
    StatsSeriesKey,
} from '../../../common/Stats';
import Timeout = NodeJS.Timeout;

export interface StatsCollectorEvents {
    sample: { udid: string; sample: StatsSample };
}

type ZoneMatcher = { key: StatsSeriesKey; test: RegExp };

// Thermal zone names differ per vendor; these patterns cover the common
// Qualcomm/MediaTek/Exynos spellings. A series takes the hottest matching zone.
const ZONE_MATCHERS: ReadonlyArray<ZoneMatcher> = [
    { key: 'cpu', test: /cpu|cluster|big|little|silver|gold|prime/i },
    { key: 'gpu', test: /gpu/i },
    { key: 'skin', test: /skin|xo-therm|quiet-therm|case|shell|ap_ntc/i },
    { key: 'modem', test: /modem|mdm|pa-therm|mmw|rf-/i },
];

// One shell round-trip per sample: battery level (%) and temperature (tenths of °C)
// from the framework, plus every readable thermal zone (usually milli-°C).
const SAMPLE_COMMAND =
    "dumpsys battery 2>/dev/null | grep -E '^ *(temperature|level):'; " +
    'for z in /sys/class/thermal/thermal_zone*; do ' +
    't=$(cat $z/temp 2>/dev/null) && echo "zone $(cat $z/type 2>/dev/null) $t"; ' +
    'done';

const SAMPLE_TIMEOUT_MS = 8000;
const MIN_VALID_CELSIUS = -30;
const MAX_VALID_CELSIUS = 150;

/**
 * Samples battery level and temperature sensors of every connected Android device
 * on a fixed interval and keeps a bounded in-memory history per device, so a client
 * opening the stats view later still gets the past hours, not just what happens
 * while the tab is open.
 */
export class StatsCollector extends TypedEmitter<StatsCollectorEvents> implements Service {
    public static readonly TAG = 'StatsCollector';
    private static instance?: StatsCollector;

    private timer?: Timeout;
    private readonly history: Map<string, StatsSample[]> = new Map();
    private readonly inFlight: Set<string> = new Set();
    private readonly failing: Set<string> = new Set();

    public static getInstance(): StatsCollector {
        if (!this.instance) {
            this.instance = new StatsCollector();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    protected constructor() {
        super();
    }

    public getName(): string {
        return 'Stats collector';
    }

    public async start(): Promise<void> {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(this.tick, STATS_SAMPLE_INTERVAL_MS);
        this.tick();
    }

    public release(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    public getHistory(udid: string): StatsSample[] {
        return this.history.get(udid) || [];
    }

    private tick = (): void => {
        if (!ControlCenter.hasInstance()) {
            return;
        }
        const controlCenter = ControlCenter.getInstance();
        controlCenter.getDevices().forEach((descriptor) => {
            if (descriptor.state !== DeviceState.DEVICE) {
                return;
            }
            const device = controlCenter.getDevice(descriptor.udid);
            if (!device || !device.isConnected()) {
                return;
            }
            this.sampleDevice(device);
        });
    };

    private async sampleDevice(device: Device): Promise<void> {
        const { udid } = device;
        if (this.inFlight.has(udid)) {
            return;
        }
        this.inFlight.add(udid);
        try {
            const output = await StatsCollector.withTimeout(
                device.runShellCommandAdbKit(SAMPLE_COMMAND),
                SAMPLE_TIMEOUT_MS,
            );
            const values = StatsCollector.parseSampleOutput(output);
            if (!values) {
                throw Error('No readings in the command output');
            }
            this.failing.delete(udid);
            this.push(udid, [Date.now(), ...values]);
        } catch (error: any) {
            // log once per failure streak, not once per tick
            if (!this.failing.has(udid)) {
                this.failing.add(udid);
                console.error(`[${StatsCollector.TAG}] [${udid}] Failed to sample: ${error.message}`);
            }
        } finally {
            this.inFlight.delete(udid);
        }
    }

    private push(udid: string, sample: StatsSample): void {
        let list = this.history.get(udid);
        if (!list) {
            list = [];
            this.history.set(udid, list);
        }
        list.push(sample);
        const cutoff = sample[0] - STATS_RETENTION_MS;
        let expired = 0;
        while (expired < list.length && list[expired][0] < cutoff) {
            expired++;
        }
        if (expired) {
            list.splice(0, expired);
        }
        this.emit('sample', { udid, sample });
    }

    /**
     * Turns the SAMPLE_COMMAND output into one value per STATS_SERIES entry.
     * Returns undefined when nothing usable was found (e.g. the shell failed).
     */
    public static parseSampleOutput(output: string): Array<number | null> | undefined {
        const values: Array<number | null> = STATS_SERIES.map(() => null);
        const indexByKey = new Map<StatsSeriesKey, number>();
        STATS_SERIES.forEach((series, index) => {
            indexByKey.set(series.key, index);
        });
        let found = false;
        output.split('\n').forEach((rawLine) => {
            const line = rawLine.trim();
            const level = line.match(/^level:\s*(\d+)$/);
            if (level) {
                const percent = parseInt(level[1], 10);
                if (percent >= 0 && percent <= 100) {
                    values[indexByKey.get('level') as number] = percent;
                    found = true;
                }
                return;
            }
            const battery = line.match(/^temperature:\s*(-?\d+)$/);
            if (battery) {
                const celsius = StatsCollector.round(parseInt(battery[1], 10) / 10);
                if (StatsCollector.isValidCelsius(celsius)) {
                    values[indexByKey.get('battery') as number] = celsius;
                    found = true;
                }
                return;
            }
            const zone = line.match(/^zone (.+) (-?\d+)$/);
            if (!zone) {
                return;
            }
            const celsius = StatsCollector.normalizeZoneValue(parseInt(zone[2], 10));
            if (!StatsCollector.isValidCelsius(celsius)) {
                return;
            }
            const matcher = ZONE_MATCHERS.find((item) => item.test.test(zone[1]));
            if (!matcher) {
                return;
            }
            const index = indexByKey.get(matcher.key) as number;
            const previous = values[index];
            if (previous === null || celsius > previous) {
                values[index] = celsius;
            }
            found = true;
        });
        return found ? values : undefined;
    }

    // The thermal sysfs ABI is milli-°C, but some vendor zones report tenths or plain degrees.
    private static normalizeZoneValue(raw: number): number {
        const abs = Math.abs(raw);
        if (abs >= 1000) {
            return StatsCollector.round(raw / 1000);
        }
        if (abs >= 200) {
            return StatsCollector.round(raw / 10);
        }
        return raw;
    }

    private static isValidCelsius(celsius: number): boolean {
        return isFinite(celsius) && celsius >= MIN_VALID_CELSIUS && celsius <= MAX_VALID_CELSIUS;
    }

    private static round(value: number): number {
        return Math.round(value * 10) / 10;
    }

    private static withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(Error(`Timed out after ${ms}ms`));
            }, ms);
            promise.then(
                (value) => {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                },
            );
        });
    }
}
