import { ACTION } from '../common/Action';
import { ParamsStream } from './ParamsStream';
import VideoSettings from '../app/VideoSettings';

export interface ParamsStreamScrcpy extends ParamsStream {
    action: ACTION.STREAM_SCRCPY;
    ws: string;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
    captureKeyboard?: boolean;
    // display name of the device, shown until the stream reports the real one
    deviceName?: string;
}
