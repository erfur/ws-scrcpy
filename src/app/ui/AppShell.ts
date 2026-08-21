import '../../style/appshell.css';

export interface TabOptions {
    id: string;
    title: string;
    className?: string;
    // when a tab with the same id exists: close and recreate it instead of focusing it
    replace?: boolean;
}

export interface TabHandle {
    id: string;
    panel: HTMLElement;
    isNew: boolean;
    setOnClose(callback: () => void): void;
    setTitle(title: string): void;
    close(): void;
}

type TabRecord = {
    id: string;
    tabEl: HTMLElement;
    titleEl: HTMLElement;
    panel: HTMLElement;
    onClose?: () => void;
};

type ActionHandler = (params: URLSearchParams) => void;

const TAG = '[AppShell]';

export class AppShell {
    private static active = false;
    private static tabs: Map<string, TabRecord> = new Map();
    private static actions: Map<string, ActionHandler> = new Map();
    private static mountTarget?: HTMLElement;
    private static deviceListHolderEl?: HTMLElement;
    private static tabBarEl?: HTMLElement;
    private static panelsEl?: HTMLElement;
    private static placeholderEl?: HTMLElement;
    private static activeTabId?: string;

    public static init(): void {
        if (this.active) {
            return;
        }
        this.active = true;
        document.body.className = 'app-shell';

        const app = document.createElement('div');
        app.id = 'app';

        const sidebar = document.createElement('aside');
        sidebar.id = 'app-sidebar';
        const sidebarHeader = document.createElement('div');
        sidebarHeader.className = 'sidebar-header';
        const appTitle = document.createElement('span');
        appTitle.className = 'app-title';
        appTitle.innerText = 'ws scrcpy';
        sidebarHeader.appendChild(appTitle);
        sidebar.appendChild(sidebarHeader);
        const deviceListHolder = (this.deviceListHolderEl = document.createElement('div'));
        deviceListHolder.id = 'app-device-list';
        sidebar.appendChild(deviceListHolder);

        const main = document.createElement('main');
        main.id = 'app-main';
        const tabBar = (this.tabBarEl = document.createElement('div'));
        tabBar.id = 'app-tab-bar';
        const sidebarToggle = document.createElement('button');
        sidebarToggle.id = 'app-sidebar-toggle';
        sidebarToggle.title = 'Toggle device list';
        sidebarToggle.innerText = '☰';
        sidebarToggle.onclick = () => {
            sidebar.classList.toggle('collapsed');
        };
        tabBar.appendChild(sidebarToggle);
        const panels = (this.panelsEl = document.createElement('div'));
        panels.id = 'app-panels';
        const placeholder = (this.placeholderEl = document.createElement('div'));
        placeholder.id = 'app-placeholder';
        placeholder.innerHTML = '<div class="placeholder-message">Select a device from the list to start</div>';
        panels.appendChild(placeholder);
        main.appendChild(tabBar);
        main.appendChild(panels);

        app.appendChild(sidebar);
        app.appendChild(main);
        document.body.appendChild(app);
    }

    public static isActive(): boolean {
        return this.active;
    }

    public static getDeviceListHolder(): HTMLElement | undefined {
        return this.deviceListHolderEl;
    }

    public static registerAction(action: string, handler: ActionHandler): void {
        this.actions.set(action, handler);
    }

    public static route(params: URLSearchParams): boolean {
        const action = params.get('action');
        if (!action) {
            return false;
        }
        const handler = this.actions.get(action);
        if (!handler) {
            return false;
        }
        try {
            handler(params);
        } catch (error: any) {
            console.error(TAG, `Failed to handle action "${action}":`, error.message);
            return false;
        }
        return true;
    }

    // The next BaseClient created will render into this element instead of document.body
    public static takeMountTarget(): HTMLElement | undefined {
        const target = this.mountTarget;
        this.mountTarget = undefined;
        return target;
    }

    public static openTab(options: TabOptions): TabHandle {
        if (!this.active) {
            this.init();
        }
        const { id, title, className, replace } = options;
        const existing = this.tabs.get(id);
        if (existing) {
            if (replace) {
                this.closeTab(id);
            } else {
                this.focusTab(id);
                return this.createHandle(existing, false);
            }
        }
        const record = this.createTab(id, title, className);
        this.tabs.set(id, record);
        this.focusTab(id);
        this.updatePlaceholder();
        this.mountTarget = record.panel;
        return this.createHandle(record, true);
    }

    public static hasTab(id: string): boolean {
        return this.tabs.has(id);
    }

    public static focusTab(id: string): boolean {
        const record = this.tabs.get(id);
        if (!record) {
            return false;
        }
        this.tabs.forEach((item) => {
            const active = item.id === id;
            item.tabEl.classList.toggle('active', active);
            item.panel.classList.toggle('hidden', !active);
        });
        this.activeTabId = id;
        return true;
    }

    public static closeTab(id: string): void {
        const record = this.tabs.get(id);
        if (!record) {
            return;
        }
        // remove the record first: `onClose` handlers may call back into `closeTab`
        this.tabs.delete(id);
        record.tabEl.remove();
        record.panel.remove();
        if (record.onClose) {
            try {
                record.onClose();
            } catch (error: any) {
                console.error(TAG, `onClose handler for tab "${id}" failed:`, error.message);
            }
        }
        if (this.activeTabId === id) {
            this.activeTabId = undefined;
            const last = Array.from(this.tabs.keys()).pop();
            if (last) {
                this.focusTab(last);
            }
        }
        this.updatePlaceholder();
    }

    // Close the tab whose panel contains the given element (used by clients that stop themselves)
    public static closeTabForElement(el: HTMLElement): void {
        for (const record of this.tabs.values()) {
            if (record.panel === el || record.panel.contains(el)) {
                this.closeTab(record.id);
                return;
            }
        }
    }

    public static setTabTitle(panelOrChild: HTMLElement, title: string): void {
        for (const record of this.tabs.values()) {
            if (record.panel === panelOrChild || record.panel.contains(panelOrChild)) {
                record.titleEl.innerText = title;
                record.titleEl.title = title;
                return;
            }
        }
    }

    private static createTab(id: string, title: string, className?: string): TabRecord {
        const tabEl = document.createElement('div');
        tabEl.className = 'app-tab';
        const titleEl = document.createElement('span');
        titleEl.className = 'app-tab-title';
        titleEl.innerText = title;
        titleEl.title = title;
        tabEl.appendChild(titleEl);
        const closeEl = document.createElement('button');
        closeEl.className = 'app-tab-close';
        closeEl.title = 'Close';
        closeEl.innerText = '×';
        closeEl.onclick = (event) => {
            event.stopPropagation();
            this.closeTab(id);
        };
        tabEl.appendChild(closeEl);
        tabEl.onclick = () => {
            this.focusTab(id);
        };
        this.tabBarEl?.appendChild(tabEl);

        const panel = document.createElement('div');
        panel.className = 'app-panel';
        if (className) {
            panel.classList.add(className);
        }
        this.panelsEl?.appendChild(panel);
        return { id, tabEl, titleEl, panel };
    }

    private static createHandle(record: TabRecord, isNew: boolean): TabHandle {
        return {
            id: record.id,
            panel: record.panel,
            isNew,
            setOnClose: (callback: () => void): void => {
                record.onClose = callback;
            },
            setTitle: (title: string): void => {
                record.titleEl.innerText = title;
                record.titleEl.title = title;
            },
            close: (): void => {
                AppShell.closeTab(record.id);
            },
        };
    }

    private static updatePlaceholder(): void {
        if (this.placeholderEl) {
            this.placeholderEl.classList.toggle('hidden', this.tabs.size > 0);
        }
    }
}
