import '../../../style/streamview.css';
import { BaseClient } from '../../client/BaseClient';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import KeyEvent from '../android/KeyEvent';
import VideoSettings from '../../VideoSettings';
import Size from '../../Size';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { ClientsStats, DisplayCombinedInfo } from '../../client/StreamReceiver';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import Util from '../../Util';
import FilePushHandler from '../filePush/FilePushHandler';
import DragAndPushLogger from '../DragAndPushLogger';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
import {
    FeaturedInteractionHandler,
    InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import DeviceMessage from '../DeviceMessage';
import { DisplayInfo } from '../../DisplayInfo';
import { AppShell } from '../../ui/AppShell';
import { ACTION } from '../../../common/Action';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { ScrcpyFilePushStream } from '../filePush/ScrcpyFilePushStream';

type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
};

const TAG = '[StreamClientScrcpy]';

const FLASH_TIMEOUT = 1400;
const STAGE_PADDING = 28;
const BITRATE_OPTIONS_MBPS = [2, 4, 8, 16];
const MAX_SIZE_OPTIONS = [720, 1080, 1440];
const MAX_SIZE_FIT = 'fit';

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private deviceName = '';
    private clientId = -1;
    private clientsCount = -1;
    private joinedStream = false;
    private requestedVideoSettings?: VideoSettings;
    private touchHandler?: FeaturedInteractionHandler;
    private player?: BasePlayer;
    private filePushHandler?: FilePushHandler;
    private fitToScreen?: boolean;
    private stopHandler?: (ev?: string | Event) => void;
    private readonly streamReceiver: StreamReceiverScrcpy;

    private stageEl?: HTMLElement;
    private flashEl?: HTMLElement;
    private flashTimer?: ReturnType<typeof setTimeout>;
    private statsEl?: HTMLElement;
    private statsTimer?: ReturnType<typeof setInterval>;
    private nameEl?: HTMLElement;
    private bitrateSelect?: HTMLSelectElement;
    private maxSizeSelect?: HTMLSelectElement;
    private keyboardTrackEl?: HTMLElement;
    private keyboardCaptured = false;
    private waitingForClipboard = false;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    private static getPlayerClass(playerName: string): PlayerClass | undefined {
        let playerClass: PlayerClass | undefined;
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                playerClass = value;
            }
        }
        return playerClass;
    }

    public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return;
        }
        return new playerClass(udid, displayInfo);
    }

    public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return false;
        }
        return playerClass.getFitToScreenStatus(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ): StreamClientScrcpy {
        if (query instanceof URLSearchParams) {
            const params = StreamClientScrcpy.parseParameters(query);
            return new StreamClientScrcpy(params, streamReceiver, player, fitToScreen, videoSettings);
        } else {
            return new StreamClientScrcpy(query, streamReceiver, player, fitToScreen, videoSettings);
        }
    }

    private static createVideoSettingsWithBounds(old: VideoSettings, newBounds: Size): VideoSettings {
        return new VideoSettings({
            crop: old.crop,
            bitrate: old.bitrate,
            bounds: newBounds,
            maxFps: old.maxFps,
            iFrameInterval: old.iFrameInterval,
            sendFrameMeta: old.sendFrameMeta,
            lockedVideoOrientation: old.lockedVideoOrientation,
            displayId: old.displayId,
            codecOptions: old.codecOptions,
            encoderName: old.encoderName,
        });
    }

    private static createVideoSettingsWithBitrate(old: VideoSettings, bitrate: number): VideoSettings {
        return new VideoSettings({
            crop: old.crop,
            bitrate,
            bounds: old.bounds,
            maxFps: old.maxFps,
            iFrameInterval: old.iFrameInterval,
            sendFrameMeta: old.sendFrameMeta,
            lockedVideoOrientation: old.lockedVideoOrientation,
            displayId: old.displayId,
            codecOptions: old.codecOptions,
            encoderName: old.encoderName,
        });
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ) {
        super(params);
        if (streamReceiver) {
            this.streamReceiver = streamReceiver;
        } else {
            this.streamReceiver = new StreamReceiverScrcpy(this.params);
        }

        const { udid, player: playerName } = this.params;
        this.deviceName = this.params.deviceName || '';
        this.startStream({ udid, player, playerName, fitToScreen, videoSettings });
        this.setBodyClass('stream');
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws', true),
            captureKeyboard: Util.parseBoolean(params, 'captureKeyboard', false),
            deviceName: Util.parseString(params, 'name', false),
        };
    }

    public OnDeviceMessage = (message: DeviceMessage): void => {
        if (message.type !== DeviceMessage.TYPE_CLIPBOARD || !this.waitingForClipboard) {
            return;
        }
        this.waitingForClipboard = false;
        const text = message.getText();
        this.copyToLocalClipboard(text)
            .then(() => {
                this.showFlash('device clipboard copied');
            })
            .catch(() => {
                this.showFlash('failed to copy clipboard');
            });
    };

    private async copyToLocalClipboard(text: string): Promise<void> {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
            if (!document.execCommand('copy')) {
                throw Error('copy rejected');
            }
        } finally {
            area.remove();
        }
    }

    public onVideo = (data: ArrayBuffer): void => {
        if (!this.player) {
            return;
        }
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE.PAUSED) {
            this.player.play();
        }
        if (this.player.getState() === STATE.PLAYING) {
            this.player.pushFrame(new Uint8Array(data));
        }
    };

    public onClientsStats = (stats: ClientsStats): void => {
        this.deviceName = stats.deviceName;
        this.clientId = stats.clientId;
        if (this.nameEl) {
            this.nameEl.innerText = this.deviceName;
        }
        this.setTitle(`Stream ${this.deviceName}`);
    };

    public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        if (!this.player) {
            return;
        }
        let currentSettings = this.player.getVideoSettings();
        const displayId = currentSettings.displayId;
        const info = infoArray.find((value) => {
            return value.displayInfo.displayId === displayId;
        });
        if (!info) {
            return;
        }
        if (this.player.getState() === BasePlayer.STATE.PAUSED) {
            this.player.play();
        }
        const { videoSettings, screenInfo } = info;
        this.player.setDisplayInfo(info.displayInfo);
        if (typeof this.fitToScreen !== 'boolean') {
            this.fitToScreen = this.player.getFitToScreenStatus();
        }
        if (this.fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                currentSettings = StreamClientScrcpy.createVideoSettingsWithBounds(currentSettings, newBounds);
                this.player.setVideoSettings(currentSettings, this.fitToScreen, false);
            }
        }
        if (!videoSettings || !screenInfo) {
            this.joinedStream = true;
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(currentSettings));
            return;
        }

        this.clientsCount = info.connectionCount;
        let min = VideoSettings.copy(videoSettings);
        const oldInfo = this.player.getScreenInfo();
        if (!screenInfo.equals(oldInfo)) {
            this.player.setScreenInfo(screenInfo);
        }

        if (!videoSettings.equals(currentSettings)) {
            this.applyNewVideoSettings(videoSettings, videoSettings.equals(this.requestedVideoSettings));
        }
        if (!oldInfo) {
            const bounds = currentSettings.bounds;
            const videoSize: Size = screenInfo.videoSize;
            const onlyOneClient = this.clientsCount === 0;
            const smallerThenCurrent = bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);
            if (onlyOneClient || smallerThenCurrent) {
                min = currentSettings;
            }
            const minBounds = currentSettings.bounds?.intersect(min.bounds);
            if (minBounds && !minBounds.equals(min.bounds)) {
                min = StreamClientScrcpy.createVideoSettingsWithBounds(min, minBounds);
            }
        }
        if (!min.equals(videoSettings) || !this.joinedStream) {
            this.joinedStream = true;
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(min));
        }
    };

    public onDisconnected = (): void => {
        this.streamReceiver.off('deviceMessage', this.OnDeviceMessage);
        this.streamReceiver.off('video', this.onVideo);
        this.streamReceiver.off('clientsStats', this.onClientsStats);
        this.streamReceiver.off('displayInfo', this.onDisplayInfo);
        this.streamReceiver.off('disconnected', this.onDisconnected);

        this.filePushHandler?.release();
        this.filePushHandler = undefined;
        this.touchHandler?.release();
        this.touchHandler = undefined;
    };

    public startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): void {
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        this.fitToScreen = fitToScreen;
        if (!player) {
            if (typeof playerName !== 'string') {
                throw Error('Must provide BasePlayer instance or playerName');
            }
            let displayInfo: DisplayInfo | undefined;
            if (this.streamReceiver && videoSettings) {
                displayInfo = this.streamReceiver.getDisplayInfo(videoSettings.displayId);
            }
            const p = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            if (typeof fitToScreen !== 'boolean') {
                fitToScreen = StreamClientScrcpy.getFitToScreen(playerName, udid, displayInfo);
            }
            player = p;
        }
        this.player = player;
        this.setTouchListeners(player);

        if (!videoSettings) {
            videoSettings = player.getVideoSettings();
        }

        const deviceView = document.createElement('div');
        deviceView.className = 'device-view stream-body';

        const stage = (this.stageEl = document.createElement('div'));
        stage.className = 'stream-stage';
        const frame = document.createElement('div');
        frame.className = 'stream-frame';
        const video = document.createElement('div');
        video.className = 'video';
        frame.appendChild(video);
        stage.appendChild(frame);
        const flash = (this.flashEl = document.createElement('div'));
        flash.className = 'stream-flash hidden';
        stage.appendChild(flash);
        deviceView.appendChild(stage);
        deviceView.appendChild(this.buildControlRail(player));

        let stopped = false;
        const stop = (ev?: string | Event) => {
            if (stopped) {
                return;
            }
            stopped = true;
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(TAG, ev);
            }
            if (this.statsTimer) {
                clearInterval(this.statsTimer);
                this.statsTimer = undefined;
            }
            if (this.flashTimer) {
                clearTimeout(this.flashTimer);
                this.flashTimer = undefined;
            }
            this.setHandleKeyboardEvents(false);
            const parent = deviceView.parentElement;
            if (parent) {
                parent.removeChild(deviceView);
            }
            this.streamReceiver.stop();
            if (this.player) {
                this.player.stop();
            }
            AppShell.closeTabForElement(this.mountPoint);
        };
        this.stopHandler = stop;

        this.mountPoint.appendChild(deviceView);
        this.fillTopBar(udid, player);
        this.setKeyboardCapture(!!this.params.captureKeyboard, false);

        player.setParent(video);
        player.pause();

        if (fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                videoSettings = StreamClientScrcpy.createVideoSettingsWithBounds(videoSettings, newBounds);
            }
        }
        this.applyNewVideoSettings(videoSettings, false);
        const element = player.getTouchableElement();
        const logger = new DragAndPushLogger(element);
        this.filePushHandler = new FilePushHandler(element, new ScrcpyFilePushStream(this.streamReceiver));
        this.filePushHandler.addEventListener(logger);

        this.statsTimer = setInterval(this.updateStats, 1000);

        const streamReceiver = this.streamReceiver;
        streamReceiver.on('deviceMessage', this.OnDeviceMessage);
        streamReceiver.on('video', this.onVideo);
        streamReceiver.on('clientsStats', this.onClientsStats);
        streamReceiver.on('displayInfo', this.onDisplayInfo);
        streamReceiver.on('disconnected', this.onDisconnected);
        console.log(TAG, player.getName(), udid);
    }

    private fillTopBar(udid: string, player: BasePlayer): void {
        const left = AppShell.getTopBarLeft(this.mountPoint);
        if (left) {
            left.innerHTML = '';
            const dot = document.createElement('span');
            dot.className = 'stream-status-dot';
            left.appendChild(dot);
            const name = (this.nameEl = document.createElement('span'));
            name.className = 'stream-device-name';
            name.innerText = this.deviceName || udid;
            left.appendChild(name);
            const serial = document.createElement('span');
            serial.className = 'stream-device-serial';
            serial.innerText = udid;
            left.appendChild(serial);
        }
        const right = AppShell.getTopBarRight(this.mountPoint);
        if (right) {
            right.innerHTML = '';
            const stats = (this.statsEl = document.createElement('span'));
            stats.className = 'stream-stats';
            stats.innerText = '— fps';
            right.appendChild(stats);
            right.appendChild(this.buildBitratePill(player));
            right.appendChild(this.buildMaxSizePill(player));
        }
    }

    private buildBitratePill(player: BasePlayer): HTMLElement {
        const pill = document.createElement('label');
        pill.className = 'stream-pill';
        pill.appendChild(document.createTextNode('bitrate'));
        const select = (this.bitrateSelect = document.createElement('select'));
        BITRATE_OPTIONS_MBPS.forEach((mbps) => {
            const option = document.createElement('option');
            option.value = mbps.toString();
            option.innerText = `${mbps} Mbps`;
            select.appendChild(option);
        });
        this.syncBitrateSelect(player.getVideoSettings());
        select.onchange = () => {
            const mbps = parseInt(select.value, 10);
            if (isNaN(mbps) || !this.player) {
                return;
            }
            const settings = StreamClientScrcpy.createVideoSettingsWithBitrate(
                this.player.getVideoSettings(),
                mbps * 1000000,
            );
            this.sendNewVideoSetting(settings);
            this.showFlash(`bitrate → ${mbps} Mbps`);
        };
        pill.appendChild(select);
        return pill;
    }

    private buildMaxSizePill(player: BasePlayer): HTMLElement {
        const pill = document.createElement('label');
        pill.className = 'stream-pill';
        pill.appendChild(document.createTextNode('max'));
        const select = (this.maxSizeSelect = document.createElement('select'));
        const fitOption = document.createElement('option');
        fitOption.value = MAX_SIZE_FIT;
        fitOption.innerText = MAX_SIZE_FIT;
        select.appendChild(fitOption);
        MAX_SIZE_OPTIONS.forEach((size) => {
            const option = document.createElement('option');
            option.value = size.toString();
            option.innerText = size.toString();
            select.appendChild(option);
        });
        this.syncMaxSizeSelect(player.getVideoSettings());
        select.onchange = () => {
            if (!this.player) {
                return;
            }
            let bounds: Size | undefined;
            if (select.value === MAX_SIZE_FIT) {
                this.fitToScreen = true;
                bounds = this.getMaxSize();
            } else {
                const size = parseInt(select.value, 10);
                if (isNaN(size)) {
                    return;
                }
                this.fitToScreen = false;
                bounds = new Size(size, size);
            }
            if (!bounds) {
                return;
            }
            const settings = StreamClientScrcpy.createVideoSettingsWithBounds(this.player.getVideoSettings(), bounds);
            this.sendNewVideoSetting(settings);
            this.showFlash(`max size → ${select.value}`);
        };
        pill.appendChild(select);
        return pill;
    }

    private syncBitrateSelect(videoSettings: VideoSettings): void {
        if (!this.bitrateSelect) {
            return;
        }
        const mbps = Math.round(videoSettings.bitrate / 1000000);
        if (BITRATE_OPTIONS_MBPS.includes(mbps)) {
            this.bitrateSelect.value = mbps.toString();
        }
    }

    private syncMaxSizeSelect(videoSettings: VideoSettings): void {
        if (!this.maxSizeSelect) {
            return;
        }
        if (this.fitToScreen) {
            this.maxSizeSelect.value = MAX_SIZE_FIT;
            return;
        }
        const { bounds } = videoSettings;
        if (!bounds) {
            this.maxSizeSelect.value = MAX_SIZE_FIT;
            return;
        }
        const max = Math.max(bounds.width, bounds.height);
        if (MAX_SIZE_OPTIONS.includes(max)) {
            this.maxSizeSelect.value = max.toString();
        }
    }

    private buildControlRail(player: BasePlayer): HTMLElement {
        const rail = document.createElement('div');
        rail.className = 'stream-rail';

        const navSection = this.buildRailSection('NAV');
        const navRow = document.createElement('div');
        navRow.className = 'rail-row';
        navRow.appendChild(
            this.buildRailButton('◁', 'back', () => this.pressKey(KeyEvent.KEYCODE_BACK, 'KEYCODE_BACK'), 'nav'),
        );
        navRow.appendChild(
            this.buildRailButton('○', 'home', () => this.pressKey(KeyEvent.KEYCODE_HOME, 'KEYCODE_HOME'), 'nav'),
        );
        navRow.appendChild(
            this.buildRailButton(
                '▢',
                'recents',
                () => this.pressKey(KeyEvent.KEYCODE_APP_SWITCH, 'KEYCODE_APP_SWITCH'),
                'nav',
            ),
        );
        navSection.appendChild(navRow);
        rail.appendChild(navSection);

        const deviceSection = this.buildRailSection('DEVICE');
        const deviceGrid = document.createElement('div');
        deviceGrid.className = 'rail-grid';
        deviceGrid.appendChild(
            this.buildRailButton('power', 'power', () => this.pressKey(KeyEvent.KEYCODE_POWER, 'KEYCODE_POWER')),
        );
        deviceGrid.appendChild(
            this.buildRailButton('screenshot', 'screenshot', () => {
                if (player.supportsScreenshot) {
                    player.createScreenshot(this.getDeviceName() || this.params.udid);
                    this.showFlash('screenshot saved');
                } else {
                    this.showFlash(`screenshot not supported by ${player.getName()}`);
                }
            }),
        );
        deviceGrid.appendChild(
            this.buildRailButton('vol −', 'volume down', () =>
                this.pressKey(KeyEvent.KEYCODE_VOLUME_DOWN, 'KEYCODE_VOLUME_DOWN'),
            ),
        );
        deviceGrid.appendChild(
            this.buildRailButton('vol +', 'volume up', () =>
                this.pressKey(KeyEvent.KEYCODE_VOLUME_UP, 'KEYCODE_VOLUME_UP'),
            ),
        );
        deviceSection.appendChild(deviceGrid);
        rail.appendChild(deviceSection);

        const inputSection = this.buildRailSection('INPUT');
        const keyboardRow = document.createElement('button');
        keyboardRow.className = 'rail-toggle-row';
        keyboardRow.title = 'Capture keyboard';
        const keyboardLabel = document.createElement('span');
        keyboardLabel.className = 'rail-toggle-label';
        keyboardLabel.innerText = 'keyboard';
        keyboardRow.appendChild(keyboardLabel);
        const track = (this.keyboardTrackEl = document.createElement('span'));
        track.className = 'rail-toggle-track';
        const knob = document.createElement('span');
        knob.className = 'rail-toggle-knob';
        track.appendChild(knob);
        keyboardRow.appendChild(track);
        keyboardRow.onclick = () => {
            this.setKeyboardCapture(!this.keyboardCaptured, true);
        };
        inputSection.appendChild(keyboardRow);
        const clipRow = document.createElement('div');
        clipRow.className = 'rail-row';
        const clipTo = this.buildRailButton('clip →', 'send clipboard to device', () => this.sendClipboardToDevice());
        const clipFrom = this.buildRailButton('clip ←', 'pull clipboard from device', () => {
            this.waitingForClipboard = true;
            this.sendMessage(new CommandControlMessage(ControlMessage.TYPE_GET_CLIPBOARD));
        });
        clipRow.appendChild(clipTo);
        clipRow.appendChild(clipFrom);
        inputSection.appendChild(clipRow);
        rail.appendChild(inputSection);

        return rail;
    }

    private buildRailSection(label: string): HTMLElement {
        const section = document.createElement('div');
        section.className = 'rail-section';
        const title = document.createElement('span');
        title.className = 'rail-section-label';
        title.innerText = label;
        section.appendChild(title);
        return section;
    }

    private buildRailButton(text: string, title: string, onClick: () => void, extraClass?: string): HTMLElement {
        const button = document.createElement('button');
        button.className = 'rail-button';
        if (extraClass) {
            button.classList.add(extraClass);
        }
        button.title = title;
        button.innerText = text;
        button.onclick = onClick;
        return button;
    }

    private pressKey(keyCode: number, label: string): void {
        this.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, keyCode, 0, 0));
        this.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keyCode, 0, 0));
        this.showFlash(label);
    }

    private sendClipboardToDevice(): void {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            this.showFlash('clipboard read not available');
            return;
        }
        navigator.clipboard
            .readText()
            .then((text) => {
                if (!text) {
                    this.showFlash('clipboard is empty');
                    return;
                }
                this.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
                this.showFlash('clipboard → device');
            })
            .catch(() => {
                this.showFlash('clipboard read failed');
            });
    }

    private setKeyboardCapture(enabled: boolean, flash: boolean): void {
        this.keyboardCaptured = enabled;
        this.setHandleKeyboardEvents(enabled);
        this.keyboardTrackEl?.classList.toggle('on', enabled);
        if (flash) {
            this.showFlash(enabled ? 'keyboard capture on' : 'keyboard capture off');
        }
    }

    private showFlash(text: string): void {
        if (!this.flashEl) {
            return;
        }
        this.flashEl.innerText = text;
        this.flashEl.classList.remove('hidden');
        if (this.flashTimer) {
            clearTimeout(this.flashTimer);
        }
        this.flashTimer = setTimeout(() => {
            this.flashEl?.classList.add('hidden');
        }, FLASH_TIMEOUT);
    }

    private updateStats = (): void => {
        if (!this.statsEl || !this.player) {
            return;
        }
        const fps = this.player.getCurrentFps();
        const screenInfo = this.player.getScreenInfo();
        let text = `${fps} fps`;
        if (screenInfo) {
            const { contentRect } = screenInfo;
            text += ` · ${contentRect.getWidth()}×${contentRect.getHeight()}`;
        }
        this.statsEl.innerText = text;
    };

    public sendMessage(message: ControlMessage): void {
        this.streamReceiver.sendEvent(message);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled) {
            KeyInputHandler.addEventListener(this);
        } else {
            KeyInputHandler.removeEventListener(this);
        }
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        this.requestedVideoSettings = videoSettings;
        this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(videoSettings));
    }

    public getClientId(): number {
        return this.clientId;
    }

    public getClientsCount(): number {
        return this.clientsCount;
    }

    public getMaxSize(): Size | undefined {
        if (!this.stageEl || !this.stageEl.isConnected) {
            return;
        }
        const width = (this.stageEl.clientWidth - 2 * STAGE_PADDING) & ~15;
        const height = (this.stageEl.clientHeight - 2 * STAGE_PADDING) & ~15;
        if (width <= 0 || height <= 0) {
            return;
        }
        return new Size(width, height);
    }

    public stop(): void {
        if (this.stopHandler) {
            this.stopHandler();
        }
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) {
            return;
        }
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }

    private applyNewVideoSettings(videoSettings: VideoSettings, saveToStorage: boolean): void {
        let fitToScreen = false;

        if (videoSettings.bounds && videoSettings.bounds.equals(this.getMaxSize())) {
            fitToScreen = true;
        }
        if (this.player) {
            this.player.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
        }
        this.syncBitrateSelect(videoSettings);
        this.syncMaxSizeSelect(videoSettings);
    }
}
