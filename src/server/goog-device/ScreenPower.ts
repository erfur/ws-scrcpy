import WS from 'ws';
import { AdbUtils } from './AdbUtils';
import { SERVER_PORT } from '../../common/Constants';
import { SCREEN_POWER_MODE_NORMAL, SCREEN_POWER_MODE_OFF } from '../../common/DisplayPower';
import Timeout = NodeJS.Timeout;

// Wire format shared with the browser client (see src/app/client/StreamReceiver.ts,
// src/app/controlMessage/ControlMessage.ts and src/app/VideoSettings.ts).
const MAGIC_BYTES_INITIAL = Buffer.from('scrcpy_initial');
const DEVICE_NAME_FIELD_LENGTH = 64;
const DISPLAY_INFO_LENGTH = 24;
const VIDEO_SETTINGS_BASE_LENGTH = 35;
const TYPE_SET_SCREEN_POWER_MODE = 10;
const TYPE_CHANGE_STREAM_PARAMETERS = 101;
const DEFAULT_DISPLAY = 0;

const TIMEOUT_MS = 8000;
// the scrcpy server wakes the device (POWER key) when a client joins while the screen
// is off; give that a moment before changing the power mode, like scrcpy's own client
const POWER_MODE_DELAY_MS = 500;
// let the message reach the device before leaving the stream
const LEAVE_DELAY_MS = 300;

/**
 * Turns the built-in display on or off through the scrcpy server running on the device.
 *
 * The websocket server only accepts control messages from sockets that joined a stream,
 * so this opens a short-lived connection, joins display 0 (reusing the settings of a
 * stream that is already running, so other viewers are not disturbed), sends
 * SET_SCREEN_POWER_MODE and leaves again. Nothing else on the device can set the
 * SurfaceFlinger power mode: `cmd display power-off` only exists on Android 15+.
 */
export class ScreenPower {
    public static readonly TAG = 'ScreenPower';

    public static async setDisplayOn(udid: string, on: boolean): Promise<void> {
        const port = await AdbUtils.forward(udid, `tcp:${SERVER_PORT}`);
        const mode = on ? SCREEN_POWER_MODE_NORMAL : SCREEN_POWER_MODE_OFF;
        return new Promise<void>((resolve, reject) => {
            const ws = new WS(`ws://127.0.0.1:${port}`);
            ws.binaryType = 'nodebuffer';
            const timers: Timeout[] = [];
            let joined = false;
            let done = false;
            const finish = (error?: Error): void => {
                if (done) {
                    return;
                }
                done = true;
                timers.forEach((timer) => clearTimeout(timer));
                if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                    ws.close();
                }
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            timers.push(
                setTimeout(() => {
                    finish(Error(`Timed out after ${TIMEOUT_MS}ms waiting for the scrcpy server`));
                }, TIMEOUT_MS),
            );
            ws.on('error', (error: Error) => {
                finish(Error(`WebSocket error: ${error.message}`));
            });
            ws.on('close', () => {
                finish(Error('The scrcpy server closed the connection before the command was sent'));
            });
            ws.on('message', (data: WS.Data) => {
                if (joined) {
                    return;
                }
                const buffer = ScreenPower.toBuffer(data);
                if (!ScreenPower.isInitialInfo(buffer)) {
                    return;
                }
                joined = true;
                const settings =
                    ScreenPower.findVideoSettings(buffer, DEFAULT_DISPLAY) || ScreenPower.minimalVideoSettings();
                ws.send(Buffer.concat([Buffer.from([TYPE_CHANGE_STREAM_PARAMETERS]), settings]));
                timers.push(
                    setTimeout(() => {
                        ws.send(Buffer.from([TYPE_SET_SCREEN_POWER_MODE, mode]), (error?: Error) => {
                            if (error) {
                                finish(error);
                                return;
                            }
                            timers.push(setTimeout(() => finish(), LEAVE_DELAY_MS));
                        });
                    }, POWER_MODE_DELAY_MS),
                );
            });
        });
    }

    private static toBuffer(data: WS.Data): Buffer {
        if (Buffer.isBuffer(data)) {
            return data;
        }
        if (Array.isArray(data)) {
            return Buffer.concat(data);
        }
        if (data instanceof ArrayBuffer) {
            return Buffer.from(data);
        }
        return Buffer.from(String(data));
    }

    private static isInitialInfo(buffer: Buffer): boolean {
        return (
            buffer.length > MAGIC_BYTES_INITIAL.length &&
            buffer.subarray(0, MAGIC_BYTES_INITIAL.length).equals(MAGIC_BYTES_INITIAL)
        );
    }

    /**
     * Extracts the serialized VideoSettings the server currently uses for `displayId`
     * from an initial-info message; undefined when no stream exists for that display.
     */
    private static findVideoSettings(buffer: Buffer, displayId: number): Buffer | undefined {
        try {
            let offset = MAGIC_BYTES_INITIAL.length + DEVICE_NAME_FIELD_LENGTH;
            const displaysCount = buffer.readInt32BE(offset);
            offset += 4;
            for (let i = 0; i < displaysCount; i++) {
                const id = buffer.readInt32BE(offset);
                offset += DISPLAY_INFO_LENGTH;
                offset += 4; // connections count
                const screenInfoLength = buffer.readInt32BE(offset);
                offset += 4 + screenInfoLength;
                const videoSettingsLength = buffer.readInt32BE(offset);
                offset += 4;
                if (id === displayId && videoSettingsLength > 0) {
                    return buffer.subarray(offset, offset + videoSettingsLength);
                }
                offset += videoSettingsLength;
            }
        } catch (error: any) {
            console.error(`[${ScreenPower.TAG}] Failed to parse initial info: ${error.message}`);
        }
        return;
    }

    // Cheapest stream we can ask for when nobody is watching: it only exists for a moment.
    private static minimalVideoSettings(): Buffer {
        const buffer = Buffer.alloc(VIDEO_SETTINGS_BASE_LENGTH);
        let offset = 0;
        offset = buffer.writeInt32BE(500000, offset); // bitrate
        offset = buffer.writeInt32BE(1, offset); // maxFps
        offset = buffer.writeInt8(10, offset); // iFrameInterval
        offset = buffer.writeInt16BE(320, offset); // bounds width
        offset = buffer.writeInt16BE(320, offset); // bounds height
        offset = buffer.writeInt16BE(0, offset); // crop left
        offset = buffer.writeInt16BE(0, offset); // crop top
        offset = buffer.writeInt16BE(0, offset); // crop right
        offset = buffer.writeInt16BE(0, offset); // crop bottom
        offset = buffer.writeInt8(0, offset); // sendFrameMeta
        offset = buffer.writeInt8(-1, offset); // lockedVideoOrientation
        offset = buffer.writeInt32BE(DEFAULT_DISPLAY, offset); // displayId
        offset = buffer.writeInt32BE(0, offset); // codecOptions length
        buffer.writeInt32BE(0, offset); // encoderName length
        return buffer;
    }
}
