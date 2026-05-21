import {apiUrl} from './manifest';

export type Receipt = {user_id: string; read_at: number};

// Mattermost 11.x requires plugin requests to carry the CSRF token; the
// older XMLHttpRequest-only protection is rejected. We read the token from
// the MMCSRF cookie that the Mattermost server sets on login.
function getCsrfToken(): string {
    try {
        const m = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    } catch (_) {
        return '';
    }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
        'X-CSRF-Token': getCsrfToken(),
        'X-Requested-With': 'XMLHttpRequest',
    };
    if (extra) {
        Object.assign(h, extra);
    }
    return h;
}

export async function markRead(postIDs: string[], channelID?: string): Promise<void> {
    if (postIDs.length === 0) {
        return;
    }
    try {
        await fetch(`${apiUrl}/read_batch`, {
            method: 'POST',
            headers: authHeaders({'Content-Type': 'application/json'}),
            credentials: 'same-origin',
            body: JSON.stringify({post_ids: postIDs, channel_id: channelID || ''}),
        });
    } catch (_) {
        // best-effort; ignore network errors
    }
}

function sanitizeReceipts(input: unknown): Receipt[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const out: Receipt[] = [];
    for (const item of input) {
        if (
            item &&
            typeof item === 'object' &&
            typeof (item as any).user_id === 'string' &&
            typeof (item as any).read_at === 'number'
        ) {
            out.push({
                user_id: (item as any).user_id,
                read_at: (item as any).read_at,
            });
        }
    }
    return out;
}

export {sanitizeReceipts};

export async function getReaders(postID: string, channelID?: string): Promise<Receipt[]> {
    try {
        const qs = `?post_id=${encodeURIComponent(postID)}${
            channelID ? `&channel_id=${encodeURIComponent(channelID)}` : ''
        }`;
        const res = await fetch(`${apiUrl}/readers${qs}`, {
            credentials: 'same-origin',
            headers: authHeaders(),
        });
        if (!res.ok) {
            return [];
        }
        const data = await res.json();
        return sanitizeReceipts(data && data.readers);
    } catch (_) {
        return [];
    }
}

export type UserProfile = {
    id: string;
    username: string;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    last_picture_update?: number;
};

function sanitizeProfiles(input: unknown): UserProfile[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const out: UserProfile[] = [];
    for (const item of input) {
        if (
            item &&
            typeof item === 'object' &&
            typeof (item as any).id === 'string' &&
            typeof (item as any).username === 'string'
        ) {
            const o = item as any;
            out.push({
                id: o.id,
                username: o.username,
                first_name: typeof o.first_name === 'string' ? o.first_name : undefined,
                last_name: typeof o.last_name === 'string' ? o.last_name : undefined,
                nickname: typeof o.nickname === 'string' ? o.nickname : undefined,
                last_picture_update:
                    typeof o.last_picture_update === 'number' ? o.last_picture_update : undefined,
            });
        }
    }
    return out;
}

export async function fetchProfilesByIds(ids: string[]): Promise<UserProfile[]> {
    if (ids.length === 0) {
        return [];
    }
    try {
        const res = await fetch('/api/v4/users/ids', {
            method: 'POST',
            credentials: 'same-origin',
            headers: authHeaders({'Content-Type': 'application/json'}),
            body: JSON.stringify(ids),
        });
        if (!res.ok) {
            return [];
        }
        return sanitizeProfiles(await res.json());
    } catch (_) {
        return [];
    }
}
