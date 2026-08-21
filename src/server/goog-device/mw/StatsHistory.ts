import { Mw } from '../../mw/Mw';
import Util from '../../../app/Util';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';
import { StatsCollector, StatsCollectorEvents } from '../services/StatsCollector';
import {
    STATS_RETENTION_MS,
    STATS_SAMPLE_INTERVAL_MS,
    STATS_SERIES,
    StatsHistoryMessage,
    StatsSampleMessage,
} from '../../../common/Stats';

/**
 * Device stats history middleware.
 *
 * The client opens one `STAT` channel per device (init data: uint32 length + udid).
 * The server answers with a `history` message holding every retained sample, then
 * streams a `sample` message each time the StatsCollector gets a new reading.
 * The channel is read-only: nothing the client sends is interpreted.
 */
export class StatsHistory extends Mw {
    public static readonly TAG = 'StatsHistory';
    protected name = 'StatsHistory';
    private readonly collector = StatsCollector.getInstance();

    public static processChannel(ws: Multiplexer, code: string, data: ArrayBuffer): Mw | undefined {
        if (code !== ChannelCode.STAT) {
            return;
        }
        if (!data || data.byteLength < 4) {
            return;
        }
        const buffer = Buffer.from(data);
        const length = buffer.readUInt32LE(0);
        const udid = Util.utf8ByteArrayToString(buffer.slice(4, 4 + length));
        if (!udid) {
            return;
        }
        return new StatsHistory(ws, udid);
    }

    constructor(ws: Multiplexer, private readonly udid: string) {
        super(ws);
        this.collector.on('sample', this.onSample);
        this.sendHistory();
    }

    private sendHistory(): void {
        const message: StatsHistoryMessage = {
            id: -1,
            type: 'history',
            data: {
                udid: this.udid,
                intervalMs: STATS_SAMPLE_INTERVAL_MS,
                retentionMs: STATS_RETENTION_MS,
                series: STATS_SERIES.slice(),
                samples: this.collector.getHistory(this.udid),
            },
        };
        this.sendMessage(message);
    }

    private onSample = ({ udid, sample }: StatsCollectorEvents['sample']): void => {
        if (udid !== this.udid) {
            return;
        }
        const message: StatsSampleMessage = { id: -1, type: 'sample', data: sample };
        this.sendMessage(message);
    };

    protected onSocketMessage(): void {
        // read-only channel
    }

    protected onSocketClose(): void {
        this.collector.off('sample', this.onSample);
        super.onSocketClose();
    }
}
