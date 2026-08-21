// Shared between the browser client (ApkInstallClient) and the server (ApkInstall middleware).

// Sub-channel command (4 ASCII bytes, same framing as the adbkit sync protocol commands)
export const APK_INSTALL_COMMAND = 'INST';

// Every uploaded APK lands in this directory on the device, and only files inside it
// may be installed (and are removed afterwards).
export const APK_INSTALL_REMOTE_DIR = '/data/local/tmp/ws-scrcpy-apk';

export type ApkInstallFlag = '-r' | '-t' | '-d' | '-g';

export type ApkInstallOption = {
    flag: ApkInstallFlag;
    title: string;
    description: string;
    default: boolean;
};

// `pm install` flags the user can toggle. Anything else is rejected by the server.
export const APK_INSTALL_OPTIONS: ReadonlyArray<ApkInstallOption> = [
    {
        flag: '-r',
        title: 'Replace existing application',
        description: 'Reinstall an existing app, keeping its data (pm install -r)',
        default: true,
    },
    {
        flag: '-t',
        title: 'Allow test packages',
        description: 'Allow APKs that are marked as test-only (pm install -t)',
        default: true,
    },
    {
        flag: '-d',
        title: 'Allow version downgrade',
        description: 'Allow installing an older version over a newer one (pm install -d)',
        default: false,
    },
    {
        flag: '-g',
        title: 'Grant all runtime permissions',
        description: 'Grant every permission listed in the manifest at install time (pm install -g)',
        default: false,
    },
];

export const APK_INSTALL_FLAGS: ReadonlyArray<string> = APK_INSTALL_OPTIONS.map((option) => option.flag);

export type ApkInstallRequest = {
    path: string;
    flags: string[];
};
