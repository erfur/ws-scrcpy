import { ParamsBase } from './ParamsBase';
import { ACTION } from '../common/Action';

export interface ParamsStats extends ParamsBase {
    action: ACTION.STATS;
    udid: string;
}
