import { NetInterface } from './NetInterface';
import { BaseDeviceDescriptor } from './BaseDeviceDescriptor';
import { DisplayPowerState } from '../common/DisplayPower';

export default interface GoogDeviceDescriptor extends BaseDeviceDescriptor {
    'ro.build.version.release': string;
    'ro.build.version.sdk': string;
    'ro.product.cpu.abi': string;
    'ro.product.manufacturer': string;
    'ro.product.model': string;
    'wifi.interface': string;
    interfaces: NetInterface[];
    pid: number;
    // battery charge level in percent, -1 when unknown
    batteryLevel: number;
    // built-in display panel state; toggled with ControlCenterCommand.SET_DISPLAY_POWER
    displayPower: DisplayPowerState;
    'last.update.timestamp': number;
}
