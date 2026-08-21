import '../../../style/devicelist.css';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { SERVER_PORT } from '../../../common/Constants';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { StreamClientScrcpy } from './StreamClientScrcpy';
import Util from '../../Util';
import { DeviceState } from '../../../common/DeviceState';
import { Message } from '../../../types/Message';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';
import { PlayerClass } from '../../player/BasePlayer';
import { AppShell } from '../../ui/AppShell';

const ADDRESS_PATTERN = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;
const TOAST_TIMEOUT = 2500;
// tools rendered inline in the card's main actions row, next to `stream`
const INLINE_TOOLS = ['shell', 'devtools'];

export class DeviceTracker extends BaseDeviceTracker<GoogDeviceDescriptor, never> {
    public static readonly ACTION = ACTION.GOOG_DEVICE_LIST;
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();
    protected static tools: Set<Tool> = new Set();
    protected tableId = 'goog_device_list';
    private connectForm?: HTMLFormElement;
    private toastEl?: HTMLElement;
    private toastTimer?: ReturnType<typeof setTimeout>;
    private readonly reconnectingUdids: Set<string> = new Set();
    private readonly pendingStreamUdids: Set<string> = new Set();
    private readonly lastKnownStates: Map<string, string> = new Map();

    public static start(hostItem: HostItem): DeviceTracker {
        const url = this.buildUrlForTracker(hostItem).toString();
        let instance = this.instancesByUrl.get(url);
        if (!instance) {
            instance = new DeviceTracker(hostItem, url);
        }
        return instance;
    }

    public static getInstance(hostItem: HostItem): DeviceTracker {
        return this.start(hostItem);
    }

    protected constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.buildDeviceTable();
        this.openNewConnection();
    }

    protected onSocketOpen(): void {
        // nothing here;
    }

    protected buildDeviceTable(): void {
        const devices = this.getOrCreateTableHolder();
        const tbody = this.getOrBuildTableBody(devices);
        const block = this.getOrCreateTrackerBlock(tbody, this.trackerName);
        block.classList.add('tracker-block');

        this.handleDeviceStateTransitions();

        block.appendChild(this.buildHeader());
        block.appendChild(this.getOrCreateToast());

        const grid = document.createElement('div');
        grid.className = 'device-grid';
        block.appendChild(grid);
        this.descriptors.forEach((item) => {
            this.buildDeviceRow(grid, item);
        });
    }

    // Detect `reconnect`/`stream` requests that were waiting for a state change
    private handleDeviceStateTransitions(): void {
        this.descriptors.forEach((device) => {
            const { udid, state } = device;
            const previous = this.lastKnownStates.get(udid);
            if (state === DeviceState.DEVICE && previous !== DeviceState.DEVICE) {
                if (this.reconnectingUdids.has(udid)) {
                    this.reconnectingUdids.delete(udid);
                    this.showToast(`${DeviceTracker.getDeviceName(device)} connected`);
                }
            }
            if (state === DeviceState.DEVICE && device.pid !== -1 && this.pendingStreamUdids.has(udid)) {
                this.pendingStreamUdids.delete(udid);
                this.openStream(device);
            }
            this.lastKnownStates.set(udid, state);
        });
    }

    private buildHeader(): HTMLElement {
        const online = this.descriptors.filter((item) => item.state === DeviceState.DEVICE).length;
        const offline = this.descriptors.length - online;
        const header = document.createElement('div');
        header.className = 'list-header';
        const left = document.createElement('div');
        left.className = 'list-header-left';
        const title = document.createElement('span');
        title.className = 'list-title';
        title.innerText = 'devices';
        title.title = this.trackerName;
        left.appendChild(title);
        const count = document.createElement('span');
        count.className = 'list-count';
        count.innerText = `${online} connected · ${offline} offline`;
        left.appendChild(count);
        header.appendChild(left);
        header.appendChild(this.getOrCreateConnectForm());
        return header;
    }

    private getOrCreateConnectForm(): HTMLFormElement {
        if (this.connectForm) {
            return this.connectForm;
        }
        const form = document.createElement('form');
        form.className = 'connect-to-address';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'ip:port';
        input.title = 'Connect to a network device, e.g. 192.168.0.42:5555';
        form.appendChild(input);
        const button = document.createElement('button');
        button.type = 'submit';
        button.innerText = 'connect';
        form.appendChild(button);
        form.onsubmit = (event: Event): void => {
            event.preventDefault();
            const address = input.value.trim();
            if (!ADDRESS_PATTERN.test(address)) {
                this.showToast('expected ip:port, e.g. 192.168.0.42:5555');
                return;
            }
            if (!this.sendCommand(ControlCenterCommand.CONNECT_DEVICE, address)) {
                return;
            }
            input.value = '';
            this.showToast(`connecting to ${address}…`);
        };
        this.connectForm = form;
        return form;
    }

    private getOrCreateToast(): HTMLElement {
        if (!this.toastEl) {
            this.toastEl = document.createElement('div');
            this.toastEl.className = 'list-toast hidden';
        }
        return this.toastEl;
    }

    private showToast(text: string): void {
        const toast = this.getOrCreateToast();
        toast.innerText = text;
        toast.classList.remove('hidden');
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
        }
        this.toastTimer = setTimeout(() => {
            toast.classList.add('hidden');
        }, TOAST_TIMEOUT);
    }

    private sendCommand(type: string, udid: string): boolean {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
            this.showToast('no connection to the tracker');
            return false;
        }
        const data: Message = {
            id: this.getNextId(),
            type,
            data: {
                udid,
            },
        };
        this.ws.send(JSON.stringify(data));
        return true;
    }

    protected setIdAndHostName(id: string, hostName: string): void {
        super.setIdAndHostName(id, hostName);
        for (const value of DeviceTracker.instancesByUrl.values()) {
            if (value.id === id && value !== this) {
                console.warn(
                    `Tracker with url: "${this.url}" has the same id(${this.id}) as tracker with url "${value.url}"`,
                );
                console.warn(`This tracker will shut down`);
                this.destroy();
            }
        }
    }

    private static getDeviceName(device: GoogDeviceDescriptor): string {
        const productName = `${device['ro.product.manufacturer']} ${device['ro.product.model']}`.trim();
        return productName || device.udid;
    }

    private static formatLastSeen(timestamp: number): string {
        if (!timestamp) {
            return '—';
        }
        const date = new Date(timestamp);
        const now = new Date();
        const pad = (value: number): string => value.toString().padStart(2, '0');
        const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (date.getTime() >= startOfDay) {
            return `today ${time}`;
        }
        if (date.getTime() >= startOfDay - 24 * 60 * 60 * 1000) {
            return `yesterday ${time}`;
        }
        return `${date.toLocaleDateString()} ${time}`;
    }

    private static formatBattery(device: GoogDeviceDescriptor): string {
        const level = device.batteryLevel;
        if (typeof level !== 'number' || isNaN(level) || level < 0) {
            return '—';
        }
        return `${level}%`;
    }

    protected static createUrl(params: ParamsDeviceTracker, udid = ''): URL {
        const secure = !!params.secure;
        const hostname = params.hostname || location.hostname;
        const port = typeof params.port === 'number' ? params.port : secure ? 443 : 80;
        const pathname = params.pathname || location.pathname;
        const urlObject = this.buildUrl({ ...params, secure, hostname, port, pathname });
        if (udid) {
            urlObject.searchParams.set('action', ACTION.PROXY_ADB);
            urlObject.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            urlObject.searchParams.set('udid', udid);
        }
        return urlObject;
    }

    private getPreferredPlayer(udid: string): PlayerClass | undefined {
        const players = StreamClientScrcpy.getPlayers();
        if (!players.length) {
            return;
        }
        const storageKey = `configure_stream::${Util.escapeUdid(udid)}::player`;
        const storedName = window.localStorage ? window.localStorage.getItem(storageKey) : null;
        const stored = players.find((player) => player.playerFullName === storedName);
        if (stored) {
            return stored;
        }
        const mse = players.find((player) => player.playerCodeName === 'mse');
        return mse || players[0];
    }

    private openStream(device: GoogDeviceDescriptor): void {
        const player = this.getPreferredPlayer(device.udid);
        if (!player) {
            this.showToast('no supported player available in this browser');
            return;
        }
        const ws = DeviceTracker.createUrl(this.params, device.udid).toString();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const q: any = {
            action: ACTION.STREAM_SCRCPY,
            udid: device.udid,
            player: player.playerCodeName,
            ws,
            captureKeyboard: true,
            name: DeviceTracker.getDeviceName(device),
        };
        const query = DeviceTracker.buildQuery(q, this.params);
        if (!AppShell.route(query)) {
            this.showToast('failed to open the stream view');
        }
    }

    private onStreamClick(device: GoogDeviceDescriptor): void {
        if (device.pid !== -1) {
            this.openStream(device);
            return;
        }
        // no server on the device yet: start it and stream once it reports a pid
        if (this.sendCommand(ControlCenterCommand.START_SERVER, device.udid)) {
            this.pendingStreamUdids.add(device.udid);
            this.showToast(`starting server on ${DeviceTracker.getDeviceName(device)}…`);
        }
    }

    private onReconnectClick(device: GoogDeviceDescriptor): void {
        if (this.sendCommand(ControlCenterCommand.CONNECT_DEVICE, device.udid)) {
            this.reconnectingUdids.add(device.udid);
            this.buildDeviceTable();
        }
    }

    private buildCardRow(label: string, value: string, valueClass?: string): HTMLElement {
        const row = document.createElement('div');
        row.className = 'card-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'card-row-label';
        labelEl.innerText = label;
        row.appendChild(labelEl);
        const valueEl = document.createElement('span');
        valueEl.className = 'card-row-value';
        if (valueClass) {
            valueEl.classList.add(valueClass);
        }
        valueEl.innerText = value;
        row.appendChild(valueEl);
        return row;
    }

    protected buildDeviceRow(tbody: Element, device: GoogDeviceDescriptor): void {
        const isActive = device.state === DeviceState.DEVICE;
        const isUnauthorized = device.state === DeviceState.UNAUTHORIZED;

        const card = document.createElement('div');
        card.className = `device-card ${isActive ? 'online' : 'offline'}`;
        card.setAttribute('data-state', device.state);

        const header = document.createElement('div');
        header.className = 'card-header';
        const name = document.createElement('span');
        name.className = 'card-name';
        name.innerText = DeviceTracker.getDeviceName(device);
        name.title = device.udid;
        header.appendChild(name);
        const chip = document.createElement('span');
        chip.className = 'card-chip';
        const dot = document.createElement('span');
        dot.className = 'card-chip-dot';
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(device.state));
        header.appendChild(chip);
        card.appendChild(header);

        const rows = document.createElement('div');
        rows.className = 'card-rows';
        rows.appendChild(this.buildCardRow('serial', device.udid));
        if (isActive) {
            const release = device['ro.build.version.release'] || '—';
            const sdk = device['ro.build.version.sdk'];
            rows.appendChild(this.buildCardRow('android', sdk ? `${release} · API ${sdk}` : release));
            rows.appendChild(this.buildCardRow('battery', DeviceTracker.formatBattery(device), 'strong'));
        } else {
            rows.appendChild(
                this.buildCardRow('last seen', DeviceTracker.formatLastSeen(device['last.update.timestamp'])),
            );
        }
        card.appendChild(rows);

        if (isActive) {
            const actions = document.createElement('div');
            actions.className = 'card-actions';
            const streamButton = document.createElement('button');
            streamButton.className = 'card-button-primary';
            streamButton.innerText = 'stream';
            streamButton.title = `Stream ${DeviceTracker.getDeviceName(device)}`;
            streamButton.onclick = () => {
                this.onStreamClick(device);
            };
            actions.appendChild(streamButton);

            const extraTools: HTMLElement[] = [];
            DeviceTracker.tools.forEach((tool) => {
                const entry = tool.createEntryForDeviceList(device, 'card-tool', this.params);
                if (!entry) {
                    return;
                }
                const entries = Array.isArray(entry) ? entry : [entry];
                entries.forEach((item) => {
                    if (!item) {
                        return;
                    }
                    const inline = INLINE_TOOLS.some((toolClass) =>
                        (item as HTMLElement).classList?.contains(toolClass),
                    );
                    if (inline) {
                        actions.appendChild(item);
                    } else {
                        extraTools.push(item as HTMLElement);
                    }
                });
            });
            card.appendChild(actions);
            if (extraTools.length) {
                const secondary = document.createElement('div');
                secondary.className = 'card-actions secondary';
                extraTools.forEach((item) => secondary.appendChild(item));
                card.appendChild(secondary);
            }
        } else {
            const actions = document.createElement('div');
            actions.className = 'card-actions';
            const reconnectButton = document.createElement('button');
            reconnectButton.className = 'card-button-ghost';
            const reconnecting = this.reconnectingUdids.has(device.udid);
            reconnectButton.innerText = reconnecting ? 'connecting…' : isUnauthorized ? 'authorize' : 'reconnect';
            reconnectButton.disabled = reconnecting;
            reconnectButton.title = isUnauthorized
                ? 'Reconnect and request authorization on the device'
                : 'Try to connect to this device';
            reconnectButton.onclick = () => {
                this.onReconnectClick(device);
            };
            actions.appendChild(reconnectButton);
            card.appendChild(actions);
        }

        tbody.appendChild(card);
    }

    protected getChannelCode(): string {
        return ChannelCode.GTRC;
    }

    public destroy(): void {
        super.destroy();
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
        }
        DeviceTracker.instancesByUrl.delete(this.url.toString());
        if (!DeviceTracker.instancesByUrl.size) {
            const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
            if (holder && holder.parentElement) {
                holder.parentElement.removeChild(holder);
            }
        }
    }
}
