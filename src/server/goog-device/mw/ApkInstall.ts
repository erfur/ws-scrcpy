import { Mw } from '../../mw/Mw';
import { AdbUtils } from '../AdbUtils';
import Util from '../../../app/Util';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';
import { FilePushReader } from '../filePush/FilePushReader';
import {
    APK_INSTALL_COMMAND,
    APK_INSTALL_FLAGS,
    APK_INSTALL_REMOTE_DIR,
    ApkInstallRequest,
} from '../../../common/ApkInstall';

/**
 * APK installer middleware.
 *
 * The client opens one `APKI` channel per device, then for every APK:
 *  1. opens a `SEND` sub-channel and streams the file with the regular file-push
 *     protocol (see FilePushReader). Destinations are restricted to APK_INSTALL_REMOTE_DIR;
 *  2. opens an `INST` sub-channel carrying a JSON ApkInstallRequest. The server runs
 *     `pm install <flags> <path>`, streams the output back as `DATA` frames, and finishes
 *     with `DONE` (success) or `FAIL` + message. The uploaded file is removed either way.
 */
export class ApkInstall extends Mw {
    public static readonly TAG = 'ApkInstall';
    protected name = 'ApkInstall';

    public static processChannel(ws: Multiplexer, code: string, data: ArrayBuffer): Mw | undefined {
        if (code !== ChannelCode.APKI) {
            return;
        }
        if (!data || data.byteLength < 4) {
            return;
        }
        const buffer = Buffer.from(data);
        const length = buffer.readInt32LE(0);
        const serial = Util.utf8ByteArrayToString(buffer.slice(4, 4 + length));
        return new ApkInstall(ws, serial);
    }

    constructor(ws: Multiplexer, private readonly serial: string) {
        super(ws);
        ws.on('channel', (params) => {
            ApkInstall.handleNewChannel(this.serial, params.channel, params.data);
        });
    }

    protected sendMessage = (): void => {
        throw Error('Do not use this method. You must send data over channels');
    };

    protected onSocketMessage(): void {
        // Nothing here. All communication are performed over the channels. See `handleNewChannel` below.
    }

    private static handleNewChannel(serial: string, channel: Multiplexer, arrayBuffer: ArrayBuffer): void {
        const data = Buffer.from(arrayBuffer);
        if (data.length < 4) {
            console.error(`[${ApkInstall.TAG}]`, `Invalid message. Too short (${data.length})`);
            return;
        }
        const cmd = Util.utf8ByteArrayToString(data.slice(0, 4));
        switch (cmd) {
            case Protocol.SEND:
                FilePushReader.handle(serial, channel, APK_INSTALL_REMOTE_DIR);
                break;
            case APK_INSTALL_COMMAND: {
                let request: ApkInstallRequest;
                try {
                    if (data.length < 8) {
                        throw Error('Invalid message. Too short');
                    }
                    const length = data.readUInt32LE(4);
                    const json = Util.utf8ByteArrayToString(data.slice(8, 8 + length));
                    request = ApkInstall.parseRequest(json);
                } catch (error: any) {
                    ApkInstall.sendFail(channel, error?.message || 'Invalid request');
                    return;
                }
                ApkInstall.install(serial, request, channel).catch((error: Error) => {
                    console.error(`[${ApkInstall.TAG}]`, error.message);
                    ApkInstall.sendFail(channel, error.message);
                });
                break;
            }
            default:
                console.error(`[${ApkInstall.TAG}]`, `Invalid message. Wrong command (${cmd})`);
                channel.close(4001, `Invalid message. Wrong command (${cmd})`);
                break;
        }
    }

    public static parseRequest(json: string): ApkInstallRequest {
        const body = JSON.parse(json);
        if (!body || typeof body !== 'object') {
            throw Error('Invalid request');
        }
        const { path, flags } = body;
        if (typeof path !== 'string' || !FilePushReader.isInsideDir(path, APK_INSTALL_REMOTE_DIR)) {
            throw Error(`Invalid path. APK must be inside "${APK_INSTALL_REMOTE_DIR}"`);
        }
        if (!Array.isArray(flags)) {
            throw Error('Invalid flags');
        }
        const unique = new Set<string>();
        flags.forEach((flag) => {
            if (typeof flag !== 'string' || !APK_INSTALL_FLAGS.includes(flag)) {
                throw Error(`Unsupported install flag "${flag}"`);
            }
            unique.add(flag);
        });
        return { path, flags: Array.from(unique) };
    }

    private static async install(serial: string, request: ApkInstallRequest, channel: Multiplexer): Promise<void> {
        const { path, flags } = request;
        const commandLine = ['pm', 'install', ...flags, path].join(' ');
        console.log(`[${ApkInstall.TAG}] [${serial}] ${commandLine}`);
        ApkInstall.sendData(channel, `$ ${commandLine}\n`);
        let output: string;
        try {
            output = await AdbUtils.installPackage(serial, path, flags);
        } finally {
            AdbUtils.removeFile(serial, path).catch((error: Error) => {
                console.error(`[${ApkInstall.TAG}] [${serial}] Failed to remove "${path}":`, error.message);
            });
        }
        if (output) {
            ApkInstall.sendData(channel, output);
        }
        if (/^Success\b/m.test(output)) {
            ApkInstall.sendDone(channel);
        } else {
            ApkInstall.sendFail(channel, ApkInstall.extractFailureReason(output));
        }
    }

    // `pm install` reports errors either as "Failure [INSTALL_FAILED_XXX: details]"
    // or as a free-form exception text; fall back to the whole output.
    private static extractFailureReason(output: string): string {
        const match = output.match(/^Failure \[(.*?)\]\s*$/m);
        if (match) {
            return match[1];
        }
        const trimmed = output.trim();
        return trimmed || 'Unknown error (empty output from `pm install`)';
    }

    private static sendData(channel: Multiplexer, text: string): void {
        if (channel.readyState !== channel.OPEN) {
            return;
        }
        channel.send(Buffer.concat([Buffer.from(Protocol.DATA, 'ascii'), Buffer.from(text, 'utf-8')]));
    }

    private static sendDone(channel: Multiplexer): void {
        if (channel.readyState !== channel.OPEN) {
            return;
        }
        channel.send(Buffer.from(Protocol.DONE, 'ascii'));
        channel.close();
    }

    private static sendFail(channel: Multiplexer, message: string): void {
        if (channel.readyState !== channel.OPEN) {
            return;
        }
        const length = Buffer.byteLength(message, 'utf-8');
        const buf = Buffer.alloc(4 + 4 + length);
        let offset = buf.write(Protocol.FAIL, 'ascii');
        offset = buf.writeUInt32LE(length, offset);
        buf.write(message, offset, 'utf-8');
        channel.send(buf);
        channel.close();
    }
}
