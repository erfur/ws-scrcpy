import '../../../style/apkinstall.css';
import { ManagerClient } from '../../client/ManagerClient';
import { ParamsApkInstall } from '../../../types/ParamsApkInstall';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { ACTION } from '../../../common/Action';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import Util from '../../Util';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { html } from '../../ui/HtmlTag';
import * as path from 'path';
import { ChannelCode } from '../../../common/ChannelCode';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import FilePushHandler, { DragAndPushListener, PushUpdateParams } from '../filePush/FilePushHandler';
import { AdbkitFilePushStream, FilePushTarget } from '../filePush/AdbkitFilePushStream';
import { DragAndDropHandler, DragEventListener } from '../DragAndDropHandler';
import {
    APK_INSTALL_COMMAND,
    APK_INSTALL_OPTIONS,
    APK_INSTALL_REMOTE_DIR,
    ApkInstallRequest,
} from '../../../common/ApkInstall';

const TAG = '[ApkInstallClient]';

enum Foreground {
    Drop = 'drop-target',
    Connect = 'connect',
}

const Message: Record<Foreground, string> = {
    [Foreground.Drop]: 'Drop APK files here',
    [Foreground.Connect]: 'Connection lost',
};

enum Phase {
    Uploading,
    Installing,
    Done,
}

type Install = {
    fileName: string;
    row: HTMLElement;
    statusEl: HTMLElement;
    progressEl: HTMLElement;
    phase: Phase;
    log: string;
    channel?: Multiplexer;
};

/**
 * "Install APK" tool tab.
 *
 * Files dropped on the tab (or picked with the file input) are streamed to
 * `APK_INSTALL_REMOTE_DIR` on the device with the regular file-push protocol, then an
 * `INST` sub-channel asks the server to run `pm install` with the selected flags.
 */
export class ApkInstallClient
    extends ManagerClient<ParamsApkInstall, never>
    implements DragAndPushListener, DragEventListener, FilePushTarget
{
    public static readonly ACTION = ACTION.APK_INSTALL;

    public static start(params: ParamsApkInstall): ApkInstallClient {
        return new ApkInstallClient(params);
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
        entry.classList.add('apk-install', blockClass);
        entry.appendChild(
            BaseDeviceTracker.buildLink(
                {
                    action: ACTION.APK_INSTALL,
                    udid: descriptor.udid,
                },
                'install apk',
                params,
            ),
        );
        return entry;
    }

    public static parseParameters(params: URLSearchParams): ParamsApkInstall {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.APK_INSTALL) {
            throw Error('Incorrect action');
        }
        return { ...typedParams, action, udid: Util.parseString(params, 'udid', true) };
    }

    public static isApkFile(file: File): boolean {
        return /\.apk$/i.test(file.name);
    }

    private readonly serial: string;
    private readonly name: string;
    private readonly parent: HTMLElement;
    private readonly filePushHandler?: FilePushHandler;
    private readonly tableBody: HTMLElement;
    private readonly fileInput: HTMLInputElement;
    private readonly optionInputs: HTMLInputElement[] = [];
    private installs: Map<string, Install> = new Map();
    private enterCount = 0;

    constructor(params: ParamsApkInstall) {
        super(params);
        this.parent = this.mountPoint;
        this.serial = this.params.udid;
        this.name = `${TAG} [${this.serial}]`;
        this.openNewConnection();
        this.setTitle(`Install APK ${this.serial}`);
        this.setBodyClass('apk-install');

        const escapedUdid = Util.escapeUdid(this.serial);
        const dropZoneId = `apk_install_${escapedUdid}_drop_zone`;
        const fileInputId = `apk_install_${escapedUdid}_input`;
        const optionsId = `apk_install_${escapedUdid}_options`;
        const tableBodyId = `apk_install_${escapedUdid}_list`;
        const fragment = html`<div class="apk-install-wrapper">
            <h1>Install APK on ${this.serial}</h1>
            <div id="${dropZoneId}" class="drop-zone" tabindex="0" role="button">
                <input id="${fileInputId}" type="file" accept=".apk,application/vnd.android.package-archive" multiple />
                <div class="drop-zone-message">
                    Drop <code>.apk</code> files anywhere in this tab, or click here to choose them
                </div>
            </div>
            <fieldset id="${optionsId}" class="install-options">
                <legend>Install options</legend>
            </fieldset>
            <table class="installs">
                <thead>
                    <tr>
                        <th>File</th>
                        <th>Size</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody id="${tableBodyId}"></tbody>
            </table>
        </div>`.content;

        this.tableBody = fragment.getElementById(tableBodyId) as HTMLElement;
        this.fileInput = fragment.getElementById(fileInputId) as HTMLInputElement;
        const dropZone = fragment.getElementById(dropZoneId) as HTMLElement;
        dropZone.addEventListener('click', () => {
            this.fileInput.click();
        });
        dropZone.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.fileInput.click();
            }
        });
        this.fileInput.addEventListener('click', (event) => {
            // don't let the click bubble back to the drop zone and reopen the dialog
            event.stopPropagation();
        });
        this.fileInput.addEventListener('change', () => {
            const files = this.fileInput.files ? Array.from(this.fileInput.files) : [];
            // reset so the same file can be picked again later
            this.fileInput.value = '';
            this.queueFiles(files);
        });

        const options = fragment.getElementById(optionsId) as HTMLElement;
        APK_INSTALL_OPTIONS.forEach((option) => {
            const label = document.createElement('label');
            label.title = option.description;
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = option.default;
            input.setAttribute('data-flag', option.flag);
            label.appendChild(input);
            label.appendChild(document.createTextNode(` ${option.title} `));
            const code = document.createElement('code');
            code.innerText = `(${option.flag})`;
            label.appendChild(code);
            options.appendChild(label);
            this.optionInputs.push(input);
        });

        if (this.ws instanceof Multiplexer) {
            // FilePushHandler registers its element as a drop target. We want to see the
            // dropped files first (to filter non-APKs and remember their sizes), so we
            // register ourselves on the real element and hand the handler a detached one.
            this.filePushHandler = new FilePushHandler(
                document.createElement('div'),
                new AdbkitFilePushStream(this.ws, this),
            );
            this.filePushHandler.addEventListener(this);
            DragAndDropHandler.addEventListener(this);
        }
        this.parent.appendChild(fragment);
    }

    // ---- FilePushTarget ----

    public getPath(): string {
        return APK_INSTALL_REMOTE_DIR;
    }

    // ---- DragEventListener (raw drops on the tab) ----

    public getElement(): HTMLElement {
        return this.parent;
    }

    public onFilesDrop(files: File[]): boolean {
        this.onDrop();
        this.queueFiles(files);
        return true;
    }

    // ---- DragAndPushListener ----

    public onDragEnter(): boolean {
        if (this.enterCount === 0) {
            this.addForeground(Foreground.Drop);
        }
        this.enterCount++;
        return true;
    }

    public onDragLeave(): boolean {
        this.enterCount--;
        if (this.enterCount < 0) {
            this.enterCount = 0;
        }
        if (this.enterCount === 0) {
            this.removeForeground(Foreground.Drop);
        }
        return true;
    }

    public onDrop(): boolean {
        this.enterCount = 0;
        this.removeForeground(Foreground.Drop);
        return true;
    }

    public onFilePushUpdate(data: PushUpdateParams): void {
        const { fileName, progress, error, message, finished } = data;
        const install = this.installs.get(fileName);
        if (!install) {
            console.warn(this.name, `Push update for unknown file "${fileName}"`);
            return;
        }
        if (install.phase !== Phase.Uploading) {
            return;
        }
        if (error) {
            this.finish(install, false, `upload failed: ${message}`);
            return;
        }
        if (finished) {
            this.install(install);
            return;
        }
        this.setProgress(install, progress);
        this.setStatus(install, `uploading ${Math.max(0, progress).toFixed(0)}%`);
    }

    public onError(error: string | Error): void {
        const message = typeof error === 'string' ? error : error.message;
        console.error(this.name, message);
        this.installs.forEach((install) => {
            if (install.phase === Phase.Uploading) {
                this.finish(install, false, message);
            }
        });
    }

    // ---- install flow ----

    private queueFiles(files: File[]): void {
        if (!files.length) {
            return;
        }
        const accepted: File[] = [];
        files.forEach((file) => {
            const install = this.createInstall(file);
            if (!install) {
                return;
            }
            if (!ApkInstallClient.isApkFile(file)) {
                this.finish(install, false, 'not an .apk file');
                return;
            }
            if (!this.filePushHandler || !this.hasConnection()) {
                this.finish(install, false, 'no connection to the server');
                return;
            }
            accepted.push(file);
        });
        if (accepted.length && this.filePushHandler) {
            this.filePushHandler.onFilesDrop(accepted);
        }
    }

    private createInstall(file: File): Install | undefined {
        const { name: fileName } = file;
        const existing = this.installs.get(fileName);
        if (existing) {
            if (existing.phase !== Phase.Done) {
                console.warn(this.name, `"${fileName}" is already being installed`);
                return;
            }
            existing.row.remove();
            this.installs.delete(fileName);
        }
        const fragment = html`<tr>
            <td class="file-name">${fileName}</td>
            <td class="file-size">${Util.prettyBytes(file.size)}</td>
            <td class="status">
                <div class="background-progress"></div>
                <span class="status-text">queued</span>
            </td>
        </tr>`.content;
        const row = fragment.querySelector('tr') as HTMLElement;
        const statusEl = fragment.querySelector('.status-text') as HTMLElement;
        const progressEl = fragment.querySelector('.background-progress') as HTMLElement;
        const install: Install = { fileName, row, statusEl, progressEl, phase: Phase.Uploading, log: '' };
        this.installs.set(fileName, install);
        this.tableBody.appendChild(fragment);
        return install;
    }

    private getSelectedFlags(): string[] {
        return this.optionInputs
            .filter((input) => input.checked)
            .map((input) => input.getAttribute('data-flag') || '')
            .filter(Boolean);
    }

    private install(install: Install): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !(this.ws instanceof Multiplexer)) {
            this.finish(install, false, 'no connection to the server');
            return;
        }
        install.phase = Phase.Installing;
        this.setProgress(install, 100);
        install.progressEl.classList.add('installing');
        this.setStatus(install, 'installing…');

        const request: ApkInstallRequest = {
            path: path.join(APK_INSTALL_REMOTE_DIR, install.fileName),
            flags: this.getSelectedFlags(),
        };
        const json = Buffer.from(JSON.stringify(request), 'utf-8');
        const payload = Buffer.alloc(4 + 4 + json.length);
        let pos = payload.write(APK_INSTALL_COMMAND, 0, 'ascii');
        pos = payload.writeUInt32LE(json.length, pos);
        json.copy(payload, pos);

        const channel = this.ws.createChannel(payload);
        install.channel = channel;
        const onMessage = (event: MessageEvent): void => {
            this.handleInstallReply(install, Buffer.from(event.data));
        };
        const onClose = (event: CloseEvent): void => {
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
            install.channel = undefined;
            if (install.phase !== Phase.Done) {
                this.finish(install, false, event.reason || 'connection closed before install finished');
            }
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
    }

    private handleInstallReply(install: Install, data: Buffer): void {
        const reply = data.slice(0, 4).toString('ascii');
        switch (reply) {
            case Protocol.DATA:
                install.log += Util.utf8ByteArrayToString(data.slice(4));
                break;
            case Protocol.DONE:
                this.finish(install, true, 'installed');
                break;
            case Protocol.FAIL: {
                const length = data.readUInt32LE(4);
                const message = Util.utf8ByteArrayToString(data.slice(8, 8 + length));
                this.finish(install, false, `install failed: ${message}`);
                break;
            }
            default:
                console.error(this.name, `Unexpected reply "${reply}"`);
        }
    }

    private finish(install: Install, success: boolean, message: string): void {
        if (install.phase === Phase.Done) {
            return;
        }
        install.phase = Phase.Done;
        if (install.channel) {
            const channel = install.channel;
            install.channel = undefined;
            if (channel.readyState === channel.OPEN || channel.readyState === channel.CONNECTING) {
                channel.close();
            }
        }
        this.setProgress(install, 100);
        install.progressEl.classList.remove('installing');
        install.progressEl.classList.toggle('error', !success);
        install.statusEl.classList.toggle('success', success);
        install.statusEl.classList.toggle('error', !success);
        this.setStatus(install, message);
        if (install.log) {
            this.appendLog(install);
        }
        const logger = success ? console.log : console.error;
        logger(this.name, `"${install.fileName}": ${message}`, install.log ? `\n${install.log}` : '');
    }

    private appendLog(install: Install): void {
        const cell = install.statusEl.parentElement;
        if (!cell) {
            return;
        }
        const pre = document.createElement('pre');
        pre.className = 'install-log';
        pre.innerText = install.log.trim();
        pre.style.display = 'none';
        const toggle = document.createElement('a');
        toggle.className = 'toggle-log';
        toggle.href = '#!';
        toggle.innerText = '[show output]';
        toggle.onclick = (event) => {
            event.preventDefault();
            const hidden = pre.style.display === 'none';
            pre.style.display = hidden ? 'block' : 'none';
            toggle.innerText = hidden ? '[hide output]' : '[show output]';
        };
        install.statusEl.appendChild(toggle);
        cell.appendChild(pre);
    }

    private setStatus(install: Install, text: string): void {
        install.statusEl.innerText = text;
    }

    private setProgress(install: Install, progress: number): void {
        const clamped = Math.max(0, Math.min(100, progress));
        install.progressEl.style.width = `${clamped}%`;
    }

    // ---- overlays ----

    private addForeground(type: Foreground): void {
        const fragment = html`<div class="foreground ${type}">
            <div class="foreground-message ${type}-message">${Message[type]}</div>
        </div>`.content;
        this.parent.appendChild(fragment);
    }

    private removeForeground(type: Foreground): void {
        const els = this.parent.getElementsByClassName(type);
        Array.from(els).forEach((el) => {
            this.parent.removeChild(el);
        });
    }

    // ---- ManagerClient ----

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelInitData(): Buffer {
        const serial = Util.stringToUtf8ByteArray(this.serial);
        const buffer = Buffer.alloc(4 + 4 + serial.byteLength);
        buffer.write(ChannelCode.APKI, 'ascii');
        buffer.writeUInt32LE(serial.length, 4);
        buffer.set(serial, 8);
        return buffer;
    }

    protected onSocketOpen(): void {
        // nothing to do: work starts when the user drops a file
    }

    protected onSocketMessage(): void {
        // We create separate channel for each request
        // Don't expect any messages on this level
    }

    protected onSocketClose(event: CloseEvent): void {
        if (this.filePushHandler) {
            this.filePushHandler.release();
        }
        this.installs.forEach((install) => {
            if (install.phase !== Phase.Done) {
                this.finish(install, false, 'connection lost');
            }
        });
        if (this.destroyed) {
            return;
        }
        console.error(this.name, 'socket closed', event.reason);
        this.addForeground(Foreground.Connect);
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        DragAndDropHandler.removeEventListener(this);
        if (this.filePushHandler) {
            this.filePushHandler.release();
        }
        this.installs.forEach((install) => {
            if (install.channel) {
                install.channel.close();
            }
        });
        this.installs.clear();
        super.destroy();
    }
}
