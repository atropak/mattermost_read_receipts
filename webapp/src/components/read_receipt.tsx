import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import ReactDOM from 'react-dom';
import {useSelector} from 'react-redux';

import {fetchProfilesByIds, getReaders, markRead, Receipt, sanitizeReceipts, UserProfile} from '../client';
import {exposeDebug, logInfo, logWarn} from '../debug';

const ANCHOR_CLASS = 'mm-rr-anchor';
const UPDATE_EVENT = 'mm-rr-update';

const EMPTY_POSTS: Record<string, MMPost> = {};
const EMPTY_PROFILES: Record<string, UserProfile> = {};

const POST_ID_RE = /^[a-z0-9]{20,30}$/i;
const POST_ID_FROM_ID_RE = /^(?:post|rhsPost|sidebarPost|searchPost)_([a-z0-9]{20,30})$/i;

type MMPost = {
    user_id: string;
    channel_id: string;
    type?: string;
    delete_at?: number;
    root_id?: string;
};

type DomPost = {postId: string; el: HTMLElement};

type ReceiptUpdate = {post_id: string; readers: Receipt[]};

type ProfileLookup = (id: string) => UserProfile | null;

export function ReadReceiptRoot(): JSX.Element {
    const currentUserId: string = useSelector(
        (s: any) => s.entities?.users?.currentUserId || '',
    );
    const posts: Record<string, MMPost> = useSelector(
        (s: any) => s.entities?.posts?.posts || EMPTY_POSTS,
    );
    const reduxProfiles: Record<string, UserProfile> = useSelector(
        (s: any) => s.entities?.users?.profiles || EMPTY_PROFILES,
    );

    const [domPosts, setDomPosts] = useState<DomPost[]>([]);
    const [receipts, setReceipts] = useState<Record<string, Receipt[]>>({});
    const [extraProfiles, setExtraProfiles] = useState<Record<string, UserProfile>>({});
    const [visibilityTick, setVisibilityTick] = useState(0);

    const markedRef = useRef<Set<string>>(new Set());
    const fetchedRef = useRef<Set<string>>(new Set());
    const fetchedProfileRef = useRef<Set<string>>(new Set());
    const lastUserRef = useRef<string>('');

    if (lastUserRef.current !== currentUserId) {
        lastUserRef.current = currentUserId;
        markedRef.current = new Set();
        fetchedRef.current = new Set();
    }

    const lookupProfile: ProfileLookup = (id) =>
        reduxProfiles[id] || extraProfiles[id] || null;

    useEffect(() => {
        let timer: number | null = null;

        const scan = () => {
            const list = findPostElements();
            setDomPosts((prev) => {
                if (sameDomPosts(prev, list)) {
                    return prev;
                }
                logInfo('domPosts updated', {
                    count: list.length,
                    samplePostIds: list.slice(0, 3).map((p) => p.postId),
                });
                return list;
            });
        };

        logInfo('ReadReceiptRoot mounted; running initial DOM scan');
        scan();
        const mo = new MutationObserver(() => {
            if (timer !== null) {
                return;
            }
            timer = window.setTimeout(() => {
                timer = null;
                scan();
            }, 150);
        });
        mo.observe(document.body, {childList: true, subtree: true});

        return () => {
            mo.disconnect();
            if (timer !== null) {
                clearTimeout(timer);
            }
        };
    }, []);

    useEffect(() => {
        const handler = () => {
            if (document.visibilityState === 'visible') {
                setVisibilityTick((t) => t + 1);
            }
        };
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
    }, []);

    // Expose a debug API the user can call from DevTools.
    useEffect(() => {
        exposeDebug({
            enableLogging: () => {
                (window as any).__readReceiptsDebugOn = true;
                // eslint-disable-next-line no-console
                console.log('[read-receipts] logging enabled — reload page for full coverage');
            },
            disableLogging: () => {
                (window as any).__readReceiptsDebugOn = false;
            },
            scan: () => {
                const list = findPostElements();
                // eslint-disable-next-line no-console
                console.log('[read-receipts] scan result', {
                    count: list.length,
                    samples: list.slice(0, 5).map((p) => ({
                        postId: p.postId,
                        elementId: p.el.id,
                        dataPostId: p.el.getAttribute('data-postid'),
                        hasTime: Boolean(
                            p.el.querySelector('time.post__time') ||
                                p.el.querySelector('.post__time') ||
                                p.el.querySelector('time'),
                        ),
                        outerHtmlStart: p.el.outerHTML.slice(0, 200),
                    })),
                });
            },
            dumpRandomPost: () => {
                const list = findPostElements();
                if (list.length === 0) {
                    // eslint-disable-next-line no-console
                    console.log('[read-receipts] no posts found');
                    return;
                }
                const sample = list[Math.floor(Math.random() * list.length)];
                // eslint-disable-next-line no-console
                console.log('[read-receipts] random post', {
                    postId: sample.postId,
                    elementId: sample.el.id,
                    outerHtml: sample.el.outerHTML,
                });
            },
            state: () => ({
                currentUserId,
                receiptsKeys: Object.keys(receipts),
                domPostsCount: domPosts.length,
                profilesCount: Object.keys(reduxProfiles).length + Object.keys(extraProfiles).length,
            }),
        });
    }, [currentUserId, receipts, domPosts, reduxProfiles, extraProfiles]);

    useEffect(() => {
        if (!currentUserId || domPosts.length === 0) {
            return undefined;
        }

        let pending: string[] = [];
        let pendingChannel = '';
        let flushTimer: number | null = null;

        const flush = () => {
            flushTimer = null;
            if (pending.length === 0) {
                return;
            }
            const batch = pending;
            const channelHint = pendingChannel;
            pending = [];
            pendingChannel = '';
            logInfo('markRead batch', {count: batch.length, postIds: batch.slice(0, 5), channelHint});
            markRead(batch, channelHint);
        };

        const io = new IntersectionObserver(
            (entries) => {
                if (document.visibilityState !== 'visible') {
                    return;
                }
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) {
                        return;
                    }
                    const target = entry.target as HTMLElement;
                    const postId = readPostId(target);
                    if (!postId) {
                        return;
                    }
                    const post = posts[postId];
                    if (!post || !isReadableByOthers(post, currentUserId)) {
                        return;
                    }
                    if (markedRef.current.has(postId)) {
                        return;
                    }
                    markedRef.current.add(postId);
                    pending.push(postId);
                    if (!pendingChannel && post.channel_id) {
                        pendingChannel = post.channel_id;
                    }
                    if (flushTimer === null) {
                        flushTimer = window.setTimeout(flush, 400);
                    }
                });
            },
            {threshold: [0, 0.1, 0.5]},
        );

        domPosts.forEach((p) => io.observe(p.el));

        return () => {
            io.disconnect();
            if (flushTimer !== null) {
                clearTimeout(flushTimer);
                flush();
            }
        };
    }, [domPosts, currentUserId, posts, visibilityTick]);

    useEffect(() => {
        if (!currentUserId) {
            return;
        }
        domPosts.forEach(({postId}) => {
            const post = posts[postId];
            if (!post || post.user_id !== currentUserId) {
                return;
            }
            if (fetchedRef.current.has(postId)) {
                return;
            }
            fetchedRef.current.add(postId);
            getReaders(postId, post.channel_id).then((rs) => {
                logInfo('getReaders result', {postId, readerCount: rs.length});
                setReceipts((prev) => ({...prev, [postId]: rs}));
            });
        });
    }, [domPosts, currentUserId, posts]);

    // Fetch any reader profiles we don't yet know about.
    useEffect(() => {
        const need = new Set<string>();
        Object.values(receipts).forEach((list) => {
            list.forEach((r) => {
                if (
                    r.user_id &&
                    !reduxProfiles[r.user_id] &&
                    !extraProfiles[r.user_id] &&
                    !fetchedProfileRef.current.has(r.user_id)
                ) {
                    need.add(r.user_id);
                }
            });
        });
        if (need.size === 0) {
            return;
        }
        const ids = Array.from(need);
        ids.forEach((id) => fetchedProfileRef.current.add(id));
        fetchProfilesByIds(ids).then((profs) => {
            if (profs.length === 0) {
                return;
            }
            setExtraProfiles((prev) => {
                const next = {...prev};
                profs.forEach((p) => {
                    next[p.id] = p;
                });
                return next;
            });
        });
    }, [receipts, reduxProfiles, extraProfiles]);

    useEffect(() => {
        const handler = (ev: Event) => {
            const detail = (ev as CustomEvent<any>).detail;
            if (!detail || typeof detail.post_id !== 'string') {
                logWarn('WS receipt update missing post_id', detail);
                return;
            }
            // Server sends readers as a JSON string (gob can't encode slices
            // through plugin RPC). Fall back to legacy "readers" field too.
            let raw: unknown = null;
            if (typeof detail.readers_json === 'string') {
                try {
                    raw = JSON.parse(detail.readers_json);
                } catch (_) {
                    raw = null;
                }
            } else if (detail.readers != null) {
                raw = detail.readers;
            }
            const cleaned = sanitizeReceipts(raw);
            logInfo('WS receipt update received', {postId: detail.post_id, readerCount: cleaned.length});
            setReceipts((prev) => ({...prev, [detail.post_id]: cleaned}));
        };
        window.addEventListener(UPDATE_EVENT, handler);
        return () => window.removeEventListener(UPDATE_EVENT, handler);
    }, []);

    return (
        <>
            {domPosts.map(({postId, el}, idx) => {
                const post = posts[postId];
                if (!post || post.user_id !== currentUserId) {
                    return null;
                }
                if (isSystemPost(post)) {
                    return null;
                }
                const anchor = ensureAnchor(el);
                if (!anchor) {
                    return null;
                }
                const readers = receipts[postId] || [];
                return ReactDOM.createPortal(
                    <CheckMarks
                        readers={readers}
                        lookupProfile={lookupProfile}
                    />,
                    anchor,
                    `rr-${postId}-${idx}`,
                );
            })}
        </>
    );
}

function findPostElements(): DomPost[] {
    const matches = Array.from(
        document.querySelectorAll<HTMLElement>(
            '[data-postid], [id^="post_"], [id^="rhsPost_"], [id^="sidebarPost_"], [id^="searchPost_"]',
        ),
    );
    const matchSet = new Set<HTMLElement>(matches);
    const list: DomPost[] = [];
    matches.forEach((el) => {
        // Keep only outermost matching elements. If an ancestor also matches,
        // skip — otherwise nested matches would produce duplicate checkmarks.
        let p: HTMLElement | null = el.parentElement;
        while (p) {
            if (matchSet.has(p)) {
                return;
            }
            p = p.parentElement;
        }
        const postId = readPostId(el);
        if (!postId) {
            return;
        }
        list.push({postId, el});
    });
    return list;
}

function readPostId(el: HTMLElement): string | null {
    const direct = el.getAttribute('data-postid');
    if (direct && POST_ID_RE.test(direct)) {
        return direct;
    }
    const id = el.id || '';
    const match = POST_ID_FROM_ID_RE.exec(id);
    if (match) {
        return match[1];
    }
    return null;
}

function sameDomPosts(a: DomPost[], b: DomPost[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i].postId !== b[i].postId || a[i].el !== b[i].el) {
            return false;
        }
    }
    return true;
}

function isReadableByOthers(post: MMPost, currentUserId: string): boolean {
    if (post.user_id === currentUserId) {
        return false;
    }
    if (post.delete_at && post.delete_at > 0) {
        return false;
    }
    if (isSystemPost(post)) {
        return false;
    }
    return true;
}

function isSystemPost(post: MMPost): boolean {
    const t = post.type || '';
    return t.startsWith('system_');
}

function ensureAnchor(postEl: HTMLElement): HTMLElement | null {
    const existing = postEl.querySelector<HTMLElement>('.' + ANCHOR_CLASS);
    if (existing) {
        return existing;
    }

    // Strategy 1: inline next to the timestamp inside the post header.
    // Only the first post of a consecutive group has this header.
    const headerTime =
        postEl.querySelector<HTMLElement>('.post__header time.post__time') ||
        postEl.querySelector<HTMLElement>('.post__header .post__time') ||
        postEl.querySelector<HTMLElement>('.post__header time');
    if (headerTime && headerTime.parentElement) {
        const anchor = makeAnchor('header');
        headerTime.parentElement.insertBefore(anchor, headerTime.nextSibling);
        logInfo('anchor placed in header', {postElementId: postEl.id});
        return anchor;
    }

    // Strategy 2: consecutive post — float an absolutely-positioned overlay in
    // the top-right corner of the post element. This never modifies the
    // message body and works regardless of how Mattermost lays out post text.
    const cs = window.getComputedStyle(postEl);
    if (cs.position === 'static') {
        postEl.style.position = 'relative';
    }
    const anchor = makeAnchor('floating');
    anchor.style.position = 'absolute';
    anchor.style.top = '6px';
    anchor.style.right = '12px';
    anchor.style.zIndex = '1';
    anchor.style.pointerEvents = 'auto';
    postEl.appendChild(anchor);
    logInfo('anchor placed as overlay', {postElementId: postEl.id});
    return anchor;
}

function makeAnchor(kind: string): HTMLElement {
    const a = document.createElement('span');
    a.className = ANCHOR_CLASS;
    a.dataset.kind = kind;
    a.style.display = 'inline-flex';
    a.style.alignItems = 'center';
    return a;
}

type CheckMarksProps = {
    readers: Receipt[];
    lookupProfile: ProfileLookup;
};

function CheckMarks({readers, lookupProfile}: CheckMarksProps): JSX.Element {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLSpanElement | null>(null);
    const closeTimer = useRef<number | null>(null);

    const read = readers.length > 0;
    // WhatsApp-style: single gray ✓ when sent, double blue ✓✓ when read.
    const glyph = read ? '✓✓' : '✓';
    const color = read ? '#0091ff' : '#8a93a3';
    const label = read
        ? readers.length > 1
            ? `Read by ${readers.length}`
            : 'Read'
        : 'Sent';

    const openNow = () => {
        if (closeTimer.current !== null) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
        if (read) {
            setOpen(true);
        }
    };

    const closeSoon = () => {
        if (closeTimer.current !== null) {
            clearTimeout(closeTimer.current);
        }
        closeTimer.current = window.setTimeout(() => {
            closeTimer.current = null;
            setOpen(false);
        }, 180);
    };

    const closeNow = () => {
        if (closeTimer.current !== null) {
            clearTimeout(closeTimer.current);
            closeTimer.current = null;
        }
        setOpen(false);
    };

    useEffect(() => {
        return () => {
            if (closeTimer.current !== null) {
                clearTimeout(closeTimer.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!open) {
            return undefined;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeNow();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    return (
        <>
            <span
                ref={triggerRef}
                tabIndex={read ? 0 : -1}
                onMouseEnter={openNow}
                onMouseLeave={closeSoon}
                onFocus={openNow}
                onBlur={closeSoon}
                aria-label={label}
                title={open ? undefined : label}
                style={{
                    marginLeft: 6,
                    color,
                    fontSize: 14,
                    fontWeight: 700,
                    lineHeight: 1,
                    display: 'inline-block',
                    verticalAlign: 'middle',
                    userSelect: 'none',
                    letterSpacing: read ? '-3px' : '0',
                    paddingRight: read ? '3px' : '0',
                    cursor: read ? 'pointer' : 'default',
                    outline: 'none',
                    transition: 'color 0.2s ease',
                }}
            >
                {glyph}
            </span>
            {open && triggerRef.current && (
                <ReadersPopover
                    anchor={triggerRef.current}
                    readers={readers}
                    lookupProfile={lookupProfile}
                    onMouseEnter={openNow}
                    onMouseLeave={closeSoon}
                />
            )}
        </>
    );
}

type PopoverProps = {
    anchor: HTMLElement;
    readers: Receipt[];
    lookupProfile: ProfileLookup;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
};

function ReadersPopover({anchor, readers, lookupProfile, onMouseEnter, onMouseLeave}: PopoverProps): JSX.Element {
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{top: number; left: number}>(() =>
        computePosition(anchor, null),
    );

    useLayoutEffect(() => {
        setPos(computePosition(anchor, popoverRef.current));
    }, [anchor, readers.length]);

    useEffect(() => {
        let raf: number | null = null;
        const update = () => {
            if (raf !== null) {
                return;
            }
            raf = window.requestAnimationFrame(() => {
                raf = null;
                setPos((prev) => {
                    const next = computePosition(anchor, popoverRef.current);
                    if (prev.top === next.top && prev.left === next.left) {
                        return prev;
                    }
                    return next;
                });
            });
        };
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            if (raf !== null) {
                window.cancelAnimationFrame(raf);
            }
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [anchor]);

    const sorted = [...readers].sort((a, b) => b.read_at - a.read_at);

    return ReactDOM.createPortal(
        <div
            ref={popoverRef}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            role='tooltip'
            style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                zIndex: 9999,
                background: 'var(--center-channel-bg, #ffffff)',
                color: 'var(--center-channel-color, #3d3c40)',
                border: '1px solid rgba(63, 67, 80, 0.16)',
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
                padding: '10px 12px 8px',
                minWidth: 240,
                maxWidth: 320,
                maxHeight: 280,
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                fontSize: 13,
                lineHeight: 1.4,
            }}
        >
            <div
                style={{
                    fontWeight: 600,
                    fontSize: 12,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    opacity: 0.65,
                    marginBottom: 8,
                }}
            >
                {`Read by ${readers.length}`}
            </div>
            {sorted.map((r) => (
                <ReaderRow
                    key={r.user_id}
                    receipt={r}
                    profile={lookupProfile(r.user_id)}
                />
            ))}
        </div>,
        document.body,
    );
}

function computePosition(anchor: HTMLElement, popover: HTMLElement | null): {top: number; left: number} {
    // If the trigger left the DOM (Mattermost virtualization), park the popover off-screen.
    if (!anchor.isConnected) {
        return {top: -9999, left: -9999};
    }
    const rect = anchor.getBoundingClientRect();
    const popH = popover ? popover.offsetHeight : 0;
    const popW = popover ? popover.offsetWidth : 260;
    const gap = 6;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;

    let top = rect.bottom + gap;
    if (popH > 0 && top + popH > viewportH - 8) {
        top = Math.max(8, rect.top - gap - popH);
    }

    let left = rect.left;
    if (left + popW > viewportW - 8) {
        left = Math.max(8, viewportW - 8 - popW);
    }
    if (left < 8) {
        left = 8;
    }

    return {top, left};
}

function ReaderRow({receipt, profile}: {receipt: Receipt; profile: UserProfile | null}): JSX.Element {
    const name = displayName(receipt.user_id, profile);
    const time = formatReadAt(receipt.read_at);
    const avatarUrl = `/api/v4/users/${encodeURIComponent(receipt.user_id)}/image?_=${profile?.last_picture_update || 0}`;

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 0',
            }}
        >
            <img
                src={avatarUrl}
                alt=''
                width={28}
                height={28}
                style={{
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    objectFit: 'cover',
                    flex: '0 0 auto',
                    background: 'rgba(63, 67, 80, 0.08)',
                }}
                onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                }}
            />
            <div style={{minWidth: 0, flex: 1}}>
                <div
                    style={{
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {name}
                </div>
                <div style={{fontSize: 12, opacity: 0.7}}>{time}</div>
            </div>
        </div>
    );
}

function displayName(userId: string, profile: UserProfile | null): string {
    if (!profile) {
        return userId.slice(0, 8);
    }
    if (profile.nickname && profile.nickname.trim()) {
        return profile.nickname;
    }
    const first = (profile.first_name || '').trim();
    const last = (profile.last_name || '').trim();
    const full = `${first} ${last}`.trim();
    if (full) {
        return full;
    }
    return profile.username || userId.slice(0, 8);
}

function formatReadAt(ts: number): string {
    if (!ts) {
        return '';
    }
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
        d.getFullYear() === yesterday.getFullYear() &&
        d.getMonth() === yesterday.getMonth() &&
        d.getDate() === yesterday.getDate();

    const timeStr = d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    if (sameDay) {
        return `Today at ${timeStr}`;
    }
    if (isYesterday) {
        return `Yesterday at ${timeStr}`;
    }

    const diffMs = now.getTime() - d.getTime();
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
    if (diffMs >= 0 && diffMs < sixDaysMs) {
        const weekday = d.toLocaleDateString(undefined, {weekday: 'long'});
        return `${weekday} at ${timeStr}`;
    }

    const dateStr = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
    return `${dateStr} at ${timeStr}`;
}
