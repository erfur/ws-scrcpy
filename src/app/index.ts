import '../style/app.css';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';
import { HostTracker } from './client/HostTracker';
import { Tool } from './client/Tool';
import { AppShell } from './ui/AppShell';

window.onload = async function (): Promise<void> {
    AppShell.init();

    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    const action = parsedQuery.get('action');

    /// #if USE_BROADWAY
    const { BroadwayPlayer } = await import('./player/BroadwayPlayer');
    StreamClientScrcpy.registerPlayer(BroadwayPlayer);
    /// #endif

    /// #if USE_H264_CONVERTER
    const { MsePlayer } = await import('./player/MsePlayer');
    StreamClientScrcpy.registerPlayer(MsePlayer);
    /// #endif

    /// #if USE_TINY_H264
    const { TinyH264Player } = await import('./player/TinyH264Player');
    StreamClientScrcpy.registerPlayer(TinyH264Player);
    /// #endif

    /// #if USE_WEBCODECS
    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);
    /// #endif

    AppShell.registerAction(StreamClientScrcpy.ACTION, (query) => {
        const params = StreamClientScrcpy.parseParameters(query);
        const tab = AppShell.openTab({
            id: `${StreamClientScrcpy.ACTION}:${params.udid}`,
            title: `Stream ${params.deviceName || params.udid}`,
            className: 'stream',
        });
        if (!tab.isNew) {
            return;
        }
        const client = StreamClientScrcpy.start(params);
        tab.setOnClose(() => {
            client.stop();
        });
    });

    /// #if INCLUDE_APPL
    {
        const { DeviceTracker } = await import('./applDevice/client/DeviceTracker');

        /// #if USE_QVH_SERVER
        const { StreamClientQVHack } = await import('./applDevice/client/StreamClientQVHack');

        DeviceTracker.registerTool(StreamClientQVHack);

        /// #if USE_WEBCODECS
        const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
        StreamClientQVHack.registerPlayer(WebCodecsPlayer);
        /// #endif

        /// #if USE_H264_CONVERTER
        const { MsePlayerForQVHack } = await import('./player/MsePlayerForQVHack');
        StreamClientQVHack.registerPlayer(MsePlayerForQVHack);
        /// #endif

        AppShell.registerAction(StreamClientQVHack.ACTION, (query) => {
            const params = StreamClientQVHack.parseParameters(query);
            const tab = AppShell.openTab({
                id: `${StreamClientQVHack.ACTION}:${params.udid}`,
                title: `Stream ${params.udid}`,
                className: 'stream',
            });
            if (!tab.isNew) {
                return;
            }
            const client = StreamClientQVHack.start(params);
            tab.setOnClose(() => {
                client.onStop();
            });
        });
        /// #endif

        /// #if USE_WDA_MJPEG_SERVER
        const { StreamClientMJPEG } = await import('./applDevice/client/StreamClientMJPEG');
        DeviceTracker.registerTool(StreamClientMJPEG);

        const { MjpegPlayer } = await import('./player/MjpegPlayer');
        StreamClientMJPEG.registerPlayer(MjpegPlayer);

        AppShell.registerAction(StreamClientMJPEG.ACTION, (query) => {
            const params = StreamClientMJPEG.parseParameters(query);
            const tab = AppShell.openTab({
                id: `${StreamClientMJPEG.ACTION}:${params.udid}`,
                title: `Stream ${params.udid}`,
                className: 'stream',
            });
            if (!tab.isNew) {
                return;
            }
            const client = StreamClientMJPEG.start(params);
            tab.setOnClose(() => {
                client.onStop();
            });
        });
        /// #endif
    }
    /// #endif

    const tools: Tool[] = [];

    /// #if INCLUDE_ADB_SHELL
    const { ShellClient } = await import('./googDevice/client/ShellClient');
    tools.push(ShellClient);
    AppShell.registerAction(ShellClient.ACTION, (query) => {
        const params = ShellClient.parseParameters(query);
        const tab = AppShell.openTab({
            id: `${ShellClient.ACTION}:${params.udid}`,
            title: `Shell ${params.udid}`,
            className: 'shell',
        });
        if (!tab.isNew) {
            return;
        }
        const client = ShellClient.start(params);
        tab.setOnClose(() => {
            client.destroy();
        });
    });
    /// #endif

    /// #if INCLUDE_DEV_TOOLS
    const { DevtoolsClient } = await import('./googDevice/client/DevtoolsClient');
    tools.push(DevtoolsClient);
    AppShell.registerAction(DevtoolsClient.ACTION, (query) => {
        const params = DevtoolsClient.parseParameters(query);
        const tab = AppShell.openTab({
            id: `${DevtoolsClient.ACTION}:${params.udid}`,
            title: `DevTools ${params.udid}`,
            className: 'devtools',
        });
        if (!tab.isNew) {
            return;
        }
        const client = DevtoolsClient.start(params);
        tab.setOnClose(() => {
            client.destroy();
        });
    });
    /// #endif

    /// #if INCLUDE_APK_INSTALL
    const { ApkInstallClient } = await import('./googDevice/client/ApkInstallClient');
    tools.push(ApkInstallClient);
    AppShell.registerAction(ApkInstallClient.ACTION, (query) => {
        const params = ApkInstallClient.parseParameters(query);
        const tab = AppShell.openTab({
            id: `${ApkInstallClient.ACTION}:${params.udid}`,
            title: `Install APK ${params.udid}`,
            className: 'apk-install',
        });
        if (!tab.isNew) {
            return;
        }
        const client = ApkInstallClient.start(params);
        tab.setOnClose(() => {
            client.destroy();
        });
    });
    /// #endif

    /// #if INCLUDE_STATS
    const { StatsClient } = await import('./googDevice/client/StatsClient');
    tools.push(StatsClient);
    AppShell.registerAction(StatsClient.ACTION, (query) => {
        const params = StatsClient.parseParameters(query);
        const tab = AppShell.openTab({
            id: `${StatsClient.ACTION}:${params.udid}`,
            title: `Stats ${params.udid}`,
            className: 'stats',
        });
        if (!tab.isNew) {
            return;
        }
        const client = StatsClient.start(params);
        tab.setOnClose(() => {
            client.destroy();
        });
    });
    /// #endif

    /// #if INCLUDE_FILE_LISTING
    const { FileListingClient } = await import('./googDevice/client/FileListingClient');
    tools.push(FileListingClient);
    AppShell.registerAction(FileListingClient.ACTION, (query) => {
        const params = FileListingClient.parseParameters(query);
        const tab = AppShell.openTab({
            id: `${FileListingClient.ACTION}:${params.udid}`,
            title: `Files ${params.udid}`,
            className: 'file-listing',
        });
        if (!tab.isNew) {
            return;
        }
        const client = FileListingClient.start(params);
        tab.setOnClose(() => {
            client.destroy();
        });
    });
    /// #endif

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }
    HostTracker.start();

    // support deep links from the pre-SPA hash-based URLs
    if (action) {
        AppShell.route(parsedQuery);
    }
};
