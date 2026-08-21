import { ParamsBase } from './ParamsBase';
import { ACTION } from '../common/Action';

export interface ParamsApkInstall extends ParamsBase {
    action: ACTION.APK_INSTALL;
    udid: string;
}
