import React from 'react';

import {ReadReceiptRoot} from './components/read_receipt';
import {logInfo, logWarn} from './debug';
import {pluginId, wsEvent} from './manifest';

declare global {
    interface Window {
        registerPlugin(id: string, plugin: any): void;
    }
}

type ErrorBoundaryState = {hasError: boolean};

class ErrorBoundary extends React.Component<{children: React.ReactNode}, ErrorBoundaryState> {
    state: ErrorBoundaryState = {hasError: false};

    static getDerivedStateFromError(): ErrorBoundaryState {
        return {hasError: true};
    }

    componentDidCatch(error: Error): void {
        try {
            // eslint-disable-next-line no-console
            console.warn('[read-receipts] render error suppressed', error);
        } catch (_) {
            // ignore
        }
    }

    render(): React.ReactNode {
        if (this.state.hasError) {
            return null;
        }
        return this.props.children;
    }
}

function SafeRoot(): JSX.Element {
    return (
        <ErrorBoundary>
            <ReadReceiptRoot />
        </ErrorBoundary>
    );
}

class Plugin {
    initialize(registry: any, _store: any): void {
        logInfo('initialize() called', {
            hasRegisterRoot: typeof registry?.registerRootComponent === 'function',
            hasRegisterWS: typeof registry?.registerWebSocketEventHandler === 'function',
            registryKeys: registry ? Object.keys(registry).slice(0, 30) : [],
        });

        try {
            if (registry && typeof registry.registerRootComponent === 'function') {
                registry.registerRootComponent(SafeRoot);
                logInfo('root component registered');
            } else {
                logWarn('registerRootComponent missing on registry');
            }
        } catch (e) {
            logWarn('failed to register root component', e);
        }

        try {
            if (registry && typeof registry.registerWebSocketEventHandler === 'function') {
                registry.registerWebSocketEventHandler(wsEvent, (msg: any) => {
                    try {
                        window.dispatchEvent(
                            new CustomEvent('mm-rr-update', {detail: msg && msg.data}),
                        );
                    } catch (_) {
                        // ignore
                    }
                });
                logInfo('websocket handler registered', wsEvent);
            } else {
                logWarn('registerWebSocketEventHandler missing on registry');
            }
        } catch (e) {
            logWarn('failed to register ws handler', e);
        }
    }
}

try {
    if (typeof window !== 'undefined' && typeof window.registerPlugin === 'function') {
        window.registerPlugin(pluginId, new Plugin());
        logInfo('window.registerPlugin called', pluginId);
    } else {
        logWarn('window.registerPlugin missing at load time');
    }
} catch (e) {
    logWarn('bundle threw at load time', e);
}
