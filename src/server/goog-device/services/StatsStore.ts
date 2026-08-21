import * as fs from 'fs';
import * as path from 'path';
import { STATS_SERIES, StatsSample } from '../../../common/Stats';

const TAG = 'StatsStore';
const FILE_EXT = '.jsonl';
const FORMAT_VERSION = 1;

type Header = { v: number; series: string[] };

type ReadResult = {
    samples: StatsSample[];
    // expired rows were skipped, or the file's columns differ from the current series
    needsRewrite: boolean;
};

/**
 * Persists the stats history as one JSON-lines file per device under `dir`:
 *
 *   {"v":1,"series":["battery","cpu",...]}   column order of the rows below
 *   [1724240000000,39.8,43.9,null,...]       one sample per line, appended live
 *
 * Columns are matched by series key on load, so a changed series list only blanks
 * the columns that no longer exist instead of shifting values around. A file is
 * rewritten ("compacted") on load when it holds expired rows or stale columns, and
 * again whenever the appended lines outgrow the retention window. Writes are
 * synchronous on purpose: it is one ~60-byte line per device every few seconds,
 * and it keeps shutdown trivial (nothing is ever left in an unflushed queue).
 */
export class StatsStore {
    private readonly linesOnDisk: Map<string, number> = new Map();
    private readonly failing: Set<string> = new Set();
    private ready = false;

    constructor(
        public readonly dir: string,
        private readonly retentionMs: number,
        private readonly compactAfterLines: number,
    ) {}

    /**
     * Reads every device file. Returns the retained samples per udid, in the
     * current series column order, oldest first.
     */
    public load(now = Date.now()): Map<string, StatsSample[]> {
        const result = new Map<string, StatsSample[]>();
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            this.ready = true;
        } catch (error: any) {
            console.error(`[${TAG}] Can't create "${this.dir}", history will not be persisted: ${error.message}`);
            return result;
        }
        let names: string[];
        try {
            names = fs.readdirSync(this.dir);
        } catch (error: any) {
            console.error(`[${TAG}] Can't read "${this.dir}": ${error.message}`);
            return result;
        }
        names
            .filter((name) => name.endsWith(FILE_EXT))
            .forEach((name) => {
                const file = path.join(this.dir, name);
                let udid: string;
                try {
                    udid = StatsStore.udidFromFileName(name);
                } catch (error: any) {
                    console.error(`[${TAG}] Skipping "${file}": ${error.message}`);
                    return;
                }
                try {
                    const { samples, needsRewrite } = StatsStore.readFile(file, now - this.retentionMs);
                    result.set(udid, samples);
                    if (needsRewrite) {
                        this.rewrite(udid, samples);
                    } else {
                        this.linesOnDisk.set(udid, samples.length);
                    }
                } catch (error: any) {
                    console.error(`[${TAG}] Skipping "${file}": ${error.message}`);
                }
            });
        return result;
    }

    /**
     * Records one new sample. `history` must return the complete retained list
     * (including `sample`); it is only called when the file has to be rewritten.
     */
    public append(udid: string, sample: StatsSample, history: () => StatsSample[]): void {
        if (!this.ready) {
            return;
        }
        try {
            const lines = this.linesOnDisk.get(udid);
            if (lines === undefined || lines >= this.compactAfterLines) {
                // first sample for this device since start, or time to drop expired lines
                this.rewrite(udid, history());
            } else {
                fs.appendFileSync(this.fileFor(udid), `${JSON.stringify(sample)}\n`);
                this.linesOnDisk.set(udid, lines + 1);
            }
            this.failing.delete(udid);
        } catch (error: any) {
            // log once per failure streak, not once per sample
            if (!this.failing.has(udid)) {
                this.failing.add(udid);
                console.error(`[${TAG}] [${udid}] Failed to write history: ${error.message}`);
            }
        }
    }

    // Writes header + every sample to a temp file and swaps it in, so a crash mid-write
    // never leaves a truncated history behind.
    private rewrite(udid: string, samples: StatsSample[]): void {
        const file = this.fileFor(udid);
        const temp = `${file}.tmp`;
        const header: Header = { v: FORMAT_VERSION, series: STATS_SERIES.map((series) => series.key) };
        const lines = [JSON.stringify(header)];
        samples.forEach((sample) => {
            lines.push(JSON.stringify(sample));
        });
        fs.writeFileSync(temp, `${lines.join('\n')}\n`);
        fs.renameSync(temp, file);
        this.linesOnDisk.set(udid, samples.length);
    }

    private static readFile(file: string, cutoff: number): ReadResult {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        const header = StatsStore.parseHeader(lines[0]);
        const currentKeys = STATS_SERIES.map((series) => series.key);
        // for every current column: its position in the file's rows, or -1 when absent
        const columns = currentKeys.map((key) => header.series.indexOf(key));
        let needsRewrite = columns.join(',') !== currentKeys.map((_key, index) => index).join(',');
        const samples: StatsSample[] = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                continue;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch (error: any) {
                // a torn last line after a crash: drop it and let the rewrite clean up
                needsRewrite = true;
                continue;
            }
            if (!Array.isArray(parsed)) {
                needsRewrite = true;
                continue;
            }
            const row: unknown[] = parsed;
            const time = row[0];
            if (typeof time !== 'number') {
                needsRewrite = true;
                continue;
            }
            if (time < cutoff) {
                needsRewrite = true;
                continue;
            }
            const sample: StatsSample = [time];
            columns.forEach((position) => {
                const value = position >= 0 ? row[position + 1] : null;
                sample.push(typeof value === 'number' && isFinite(value) ? value : null);
            });
            samples.push(sample);
        }
        return { samples, needsRewrite };
    }

    private static parseHeader(line: string | undefined): Header {
        if (!line) {
            throw Error('Empty file');
        }
        const header = JSON.parse(line);
        if (!header || header.v !== FORMAT_VERSION || !Array.isArray(header.series)) {
            throw Error('Unsupported file header');
        }
        return header;
    }

    private fileFor(udid: string): string {
        return path.join(this.dir, `${encodeURIComponent(udid)}${FILE_EXT}`);
    }

    private static udidFromFileName(name: string): string {
        return decodeURIComponent(name.slice(0, -FILE_EXT.length));
    }
}
