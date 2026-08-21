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
    titleEl: HTMLElement;
    panel: HTMLElement;
    topBarLeft: HTMLElement;
    topBarRight: HTMLElement;
    onClose?: () => void;
};

type ActionHandler = (params: URLSearchParams) => void;

const TAG = '[AppShell]';

// Two-level navigation matching the minimal UI design: a full-page device
// list and a content view (stream/shell/devtools/...) with a top bar that
// carries the "← devices" back button. Only one content panel is open at a
// time; going back to the device list closes it.
export class AppShell {
    private static active = false;
    private static tabs: Map<string, TabRecord> = new Map();
    private static actions: Map<string, ActionHandler> = new Map();
    private static mountTarget?: HTMLElement;
    private static listViewEl?: HTMLElement;
    private static contentViewEl?: HTMLElement;
    private static topBarLeftHolderEl?: HTMLElement;
    private static topBarRightHolderEl?: HTMLElement;
    private static panelsEl?: HTMLElement;
    private static activeTabId?: string;

    public static init(): void {
        if (this.active) {
            return;
        }
        this.active = true;
        document.body.className = 'app-shell';

        const app = document.createElement('div');
        app.id = 'app';

        const listView = (this.listViewEl = document.createElement('div'));
        listView.id = 'app-list-view';

        const contentView = (this.contentViewEl = document.createElement('div'));
        contentView.id = 'app-content-view';
        contentView.classList.add('hidden');

        const topBar = document.createElement('div');
        topBar.id = 'app-top-bar';
        const backButton = document.createElement('button');
        backButton.id = 'app-back-button';
        backButton.innerText = '← devices';
        backButton.title = 'Back to the device list';
        backButton.onclick = () => {
            this.showList();
        };
        topBar.appendChild(backButton);
        const topBarLeft = (this.topBarLeftHolderEl = document.createElement('div'));
        topBarLeft.id = 'app-top-bar-left';
        topBar.appendChild(topBarLeft);
        const topBarRight = (this.topBarRightHolderEl = document.createElement('div'));
        topBarRight.id = 'app-top-bar-right';
        topBar.appendChild(topBarRight);
        contentView.appendChild(topBar);

        const panels = (this.panelsEl = document.createElement('div'));
        panels.id = 'app-panels';
        contentView.appendChild(panels);

        app.appendChild(listView);
        app.appendChild(contentView);
        document.body.appendChild(app);
    }

    public static isActive(): boolean {
        return this.active;
    }

    public static getDeviceListHolder(): HTMLElement | undefined {
        return this.listViewEl;
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
        // a single content panel at a time: opening a new one closes the rest
        for (const openId of Array.from(this.tabs.keys())) {
            if (openId !== id) {
                this.closeTab(openId);
            }
        }
        const record = this.createTab(id, title, className);
        this.tabs.set(id, record);
        this.focusTab(id);
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
            item.panel.classList.toggle('hidden', !active);
            item.topBarLeft.classList.toggle('hidden', !active);
            item.topBarRight.classList.toggle('hidden', !active);
        });
        this.activeTabId = id;
        this.showContent();
        return true;
    }

    public static closeTab(id: string): void {
        const record = this.tabs.get(id);
        if (!record) {
            return;
        }
        // remove the record first: `onClose` handlers may call back into `closeTab`
        this.tabs.delete(id);
        record.panel.remove();
        record.topBarLeft.remove();
        record.topBarRight.remove();
        if (record.onClose) {
            try {
                record.onClose();
            } catch (error: any) {
                console.error(TAG, `onClose handler for tab "${id}" failed:`, error.message);
            }
        }
        if (this.activeTabId === id) {
            this.activeTabId = undefined;
        }
        if (!this.tabs.size) {
            this.showList();
        }
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
        const record = this.findRecord(panelOrChild);
        if (record) {
            record.titleEl.innerText = title;
            record.titleEl.title = title;
        }
    }

    // Top bar area right after the back button; clients may fill it with custom content
    public static getTopBarLeft(panelOrChild: HTMLElement): HTMLElement | undefined {
        return this.findRecord(panelOrChild)?.topBarLeft;
    }

    // Right-aligned top bar area of the panel's view
    public static getTopBarRight(panelOrChild: HTMLElement): HTMLElement | undefined {
        return this.findRecord(panelOrChild)?.topBarRight;
    }

    private static findRecord(panelOrChild: HTMLElement): TabRecord | undefined {
        for (const record of this.tabs.values()) {
            if (record.panel === panelOrChild || record.panel.contains(panelOrChild)) {
                return record;
            }
        }
        return;
    }

    private static showList(): void {
        for (const openId of Array.from(this.tabs.keys())) {
            this.closeTab(openId);
        }
        this.listViewEl?.classList.remove('hidden');
        this.contentViewEl?.classList.add('hidden');
    }

    private static showContent(): void {
        this.listViewEl?.classList.add('hidden');
        this.contentViewEl?.classList.remove('hidden');
    }

    private static createTab(id: string, title: string, className?: string): TabRecord {
        const topBarLeft = document.createElement('div');
        topBarLeft.className = 'top-bar-slot top-bar-slot-left';
        const titleEl = document.createElement('span');
        titleEl.className = 'top-bar-title';
        titleEl.innerText = title;
        titleEl.title = title;
        topBarLeft.appendChild(titleEl);
        this.topBarLeftHolderEl?.appendChild(topBarLeft);

        const topBarRight = document.createElement('div');
        topBarRight.className = 'top-bar-slot top-bar-slot-right';
        this.topBarRightHolderEl?.appendChild(topBarRight);

        const panel = document.createElement('div');
        panel.className = 'app-panel';
        if (className) {
            panel.classList.add(className);
        }
        this.panelsEl?.appendChild(panel);
        return { id, titleEl, panel, topBarLeft, topBarRight };
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
}
