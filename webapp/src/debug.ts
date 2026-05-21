const TAG = '[read-receipts]';

// Default-on for early-test builds so the user can diagnose issues without
// having to flip a flag in DevTools first. Disable at runtime with:
//   window.__readReceiptsDebugOff = true;
function isOn(): boolean {
    try {
        if ((window as any).__readReceiptsDebugOff) {
            return false;
        }
        if (typeof (window as any).__readReceiptsDebugOn === 'boolean') {
            return Boolean((window as any).__readReceiptsDebugOn);
        }
        return true;
    } catch (_) {
        return false;
    }
}

export function logInfo(...args: unknown[]): void {
    if (!isOn()) {
        return;
    }
    try {
        // eslint-disable-next-line no-console
        console.log(TAG, ...args);
    } catch (_) {
        // ignore
    }
}

export function logWarn(...args: unknown[]): void {
    try {
        // eslint-disable-next-line no-console
        console.warn(TAG, ...args);
    } catch (_) {
        // ignore
    }
}

export function exposeDebug(api: Record<string, unknown>): void {
    try {
        (window as any).__readReceipts = api;
    } catch (_) {
        // ignore
    }
}
