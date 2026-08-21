import { WDAMethod } from './WDAMethod';

export class ControlCenterCommand {
    public static KILL_SERVER = 'kill_server';
    public static START_SERVER = 'start_server';
    public static UPDATE_INTERFACES = 'update_interfaces';
    public static CONNECT_DEVICE = 'connect_device';
    public static CONFIGURE_STREAM = 'configure_stream';
    public static SET_DISPLAY_POWER = 'set_display_power';
    public static RUN_WDA = 'run-wda';
    public static REQUEST_WDA = 'request-wda';

    private id = -1;
    private type = '';
    private pid = 0;
    private udid = '';
    private method = '';
    private args?: any;
    private data?: any;

    public static fromJSON(json: string): ControlCenterCommand {
        const body = JSON.parse(json);
        if (!body) {
            throw new Error('Invalid input');
        }
        const command = new ControlCenterCommand();
        const data = (command.data = body.data);
        command.id = body.id;
        command.type = body.type;

        if (typeof data.udid === 'string') {
            command.udid = data.udid;
        }
        switch (body.type) {
            case this.KILL_SERVER:
                if (typeof data.pid !== 'number' && data.pid <= 0) {
                    throw new Error('Invalid "pid" value');
                }
                command.pid = data.pid;
                return command;
            case this.REQUEST_WDA:
                if (typeof data.method !== 'string') {
                    throw new Error('Invalid "method" value');
                }
                command.method = data.method;
                command.args = data.args;
                return command;
            case this.SET_DISPLAY_POWER:
                if (typeof data.on !== 'boolean') {
                    throw new Error('Invalid "on" value');
                }
                return command;
            case this.START_SERVER:
            case this.UPDATE_INTERFACES:
            case this.CONNECT_DEVICE:
            case this.CONFIGURE_STREAM:
            case this.RUN_WDA:
                return command;
            default:
                throw new Error(`Unknown command "${body.command}"`);
        }
    }

    public getType(): string {
        return this.type;
    }
    public getPid(): number {
        return this.pid;
    }
    public getUdid(): string {
        return this.udid;
    }
    public getId(): number {
        return this.id;
    }
    public getMethod(): WDAMethod | string {
        return this.method;
    }
    public getData(): any {
        return this.data;
    }
    // SET_DISPLAY_POWER: requested display state
    public isDisplayOn(): boolean {
        return this.data?.on === true;
    }
    public getArgs(): any {
        return this.args;
    }
}
