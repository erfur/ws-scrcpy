import { EventMap, TypedEmitter } from '../../common/TypedEmitter';
import { ParamsBase } from '../../types/ParamsBase';
import { AppShell } from '../ui/AppShell';
import Util from '../Util';

export class BaseClient<P extends ParamsBase, TE extends EventMap> extends TypedEmitter<TE> {
    protected title = 'BaseClient';
    protected params: P;
    // Element this client renders into: a tab panel when opened inside the app
    // shell, `document.body` otherwise.
    protected readonly mountPoint: HTMLElement;

    protected constructor(params: P) {
        super();
        this.params = params;
        this.mountPoint = AppShell.takeMountTarget() || document.body;
    }

    protected isMountedInPanel(): boolean {
        return this.mountPoint !== document.body;
    }

    public static parseParameters(query: URLSearchParams): ParamsBase {
        const action = Util.parseStringEnv(query.get('action'));
        if (!action) {
            throw TypeError('Invalid action');
        }
        return {
            action: action,
            useProxy: Util.parseBooleanEnv(query.get('useProxy')),
            secure: Util.parseBooleanEnv(query.get('secure')),
            hostname: Util.parseStringEnv(query.get('hostname')),
            port: Util.parseIntEnv(query.get('port')),
            pathname: Util.parseStringEnv(query.get('pathname')),
        };
    }

    public setTitle(text = this.title): void {
        if (this.isMountedInPanel()) {
            AppShell.setTabTitle(this.mountPoint, text);
            return;
        }
        if (AppShell.isActive()) {
            // the shell owns the document title
            return;
        }
        let titleTag: HTMLTitleElement | null = document.querySelector('head > title');
        if (!titleTag) {
            titleTag = document.createElement('title');
        }
        titleTag.innerText = text;
    }

    public setBodyClass(text: string): void {
        if (this.isMountedInPanel()) {
            this.mountPoint.classList.add(...text.split(' ').filter(Boolean));
            return;
        }
        if (AppShell.isActive()) {
            // the shell owns the body class
            return;
        }
        document.body.className = text;
    }
}
