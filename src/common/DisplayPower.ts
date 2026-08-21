// Power state of the device's built-in display, as last observed by the server.
// `unknown` when the device does not expose it (or has not been queried yet).
export type DisplayPowerState = 'on' | 'off' | 'unknown';

// scrcpy server values for SET_SCREEN_POWER_MODE (android.view.SurfaceControl power modes).
// Off keeps the device awake and controllable while the panel is dark; 2 = POWER_MODE_NORMAL
// (1 is POWER_MODE_DOZE, which is not what "screen on" means).
export const SCREEN_POWER_MODE_OFF = 0;
export const SCREEN_POWER_MODE_NORMAL = 2;
