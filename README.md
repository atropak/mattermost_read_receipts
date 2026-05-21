# Mattermost Read Receipts

WhatsApp-style read receipts for Mattermost — Direct Messages, channels, and threads.

A single gray `✓` appears under each message you send. Once another participant actually views the message it turns into a blue `✓✓`. Hovering the blue marks pops up a panel listing exactly **who** read it and **when**, with avatars.

Tested against Mattermost **11.4** and **11.7** (single-node, PostgreSQL).

---

## Features

- `✓` (gray) when delivered to the server, `✓✓` (blue) once at least one recipient has seen it — same semantics as WhatsApp.
- Works in **DMs**, **public/private channels**, and **threaded replies (RHS)**.
- Visibility detection via `IntersectionObserver` — a message is only marked read once it actually appears in the reader's viewport (and the browser tab is in the foreground).
- **Live updates** — when a recipient reads your message you see the tick flip blue in real time over Mattermost's existing WebSocket connection.
- **Hover popover** showing each reader's avatar, name, and a human-readable timestamp ("Today at 14:32", "Wednesday at 23:09", "May 14 at 09:00").
- Survives **page refresh** — receipts are stored in Mattermost's plugin KV store, so reloading the sender's tab keeps the blue ticks visible.
- Cleans up KV entries when posts are deleted (`MessageHasBeenDeleted` hook), so storage doesn't grow unbounded.

---

## Installation

### Option A — install a pre-built bundle

Grab `com.mattermost.read-receipts-<version>.tar.gz` from the latest release (or build your own, below).

1. Sign in to Mattermost as a **System Admin**.
2. **System Console → Plugin Management** → **Choose File** under "Upload Plugin" → upload the `.tar.gz`.
3. Click **Enable** on the freshly installed plugin.
4. Hard-refresh open browser tabs (`Ctrl + Shift + R`).

### Option B — build it yourself

You need:
- **Go ≥ 1.21** on your `PATH`
- **Node.js ≥ 18** and **npm**
- **tar** (Windows 10+ ships with it; Linux/macOS already have it)

Clone and build:

```bash
git clone https://github.com/atropak/mattermost_read_receipts.git
cd mattermost_read_receipts
```

Windows (PowerShell):

```powershell
.\build.ps1
```

Linux / macOS (any POSIX shell can use Go's archive/tar packer too):

```bash
# Build all server binaries
for target in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64; do
    GOOS=${target%-*} GOARCH=${target##*-} CGO_ENABLED=0 \
        go build -trimpath -ldflags '-s -w' \
        -o "server/dist/plugin-${target}$([ "${target%-*}" = windows ] && echo .exe)" ./server
done
# Build webapp
( cd webapp && npm install && npm run build )
# Stage + pack with proper +x on server binaries
mkdir -p "dist/com.mattermost.read-receipts-0.1.0/server/dist" \
         "dist/com.mattermost.read-receipts-0.1.0/webapp/dist"
cp plugin.json dist/com.mattermost.read-receipts-0.1.0/
cp server/dist/* dist/com.mattermost.read-receipts-0.1.0/server/dist/
cp webapp/dist/main.js dist/com.mattermost.read-receipts-0.1.0/webapp/dist/
go run ./tools/pack dist/com.mattermost.read-receipts-0.1.0 \
                    dist/com.mattermost.read-receipts-0.1.0.tar.gz
```

The output bundle is `dist/com.mattermost.read-receipts-0.1.0.tar.gz`. Upload it the same way as Option A.

---

## How it works

```
┌──────────────────┐                      ┌──────────────────┐
│ Reader's webapp  │                      │ Sender's webapp  │
│ ───────────────  │                      │ ───────────────  │
│ MutationObserver │                      │  React portals   │
│ + IntersectionO. │                      │   render ✓ / ✓✓  │
└──────┬───────────┘                      └────────▲─────────┘
       │ POST /read_batch                          │ WS broadcast
       │  (post_id, channel_id)                    │ (post_id, readers_json)
       ▼                                           │
┌─────────────────────────────────────────────────────────────┐
│              Mattermost server (plugin)                      │
│  ─────────────────────────────────────────                   │
│  • ServeHTTP — handles /api/v1/read_batch, /readers, /version│
│  • KVStore  — receipt:<postID> → JSON array of readers       │
│  • PublishWebSocketEvent — notify channel members            │
│  • MessageHasBeenDeleted hook — cleanup KV entry             │
└─────────────────────────────────────────────────────────────┘
```

**Webapp (`webapp/src/`)**
- `index.tsx` — registers a root component and a WebSocket event handler with Mattermost's plugin registry. Wrapped in a `React.ErrorBoundary` so a render error can never white-screen Mattermost.
- `components/read_receipt.tsx` — discovers post DOM elements via `MutationObserver`, observes them with `IntersectionObserver`, marks them read when they enter the viewport, and renders the checkmark via a React portal anchored next to each post's timestamp (or in the top-right corner for consecutive posts).
- `client.ts` — wraps the plugin HTTP endpoints. Sends Mattermost's `X-CSRF-Token` (read from the `MMCSRF` cookie) on every request — Mattermost 11.x deprecated the older `X-Requested-With` CSRF check.

**Server (`server/`)**
- `api.go` — HTTP API: `POST /api/v1/read_batch` records reads, `GET /api/v1/readers` fetches the readers of a post, `GET /api/v1/version` returns the build tag for diagnostic purposes. WebSocket broadcasts carry the receipts as a **JSON string** (`readers_json`) because gob can't encode slice/map values nested inside a `map[string]interface{}` payload — passing anything other than primitive leaves would permanently kill the plugin's RPC channel.
- `plugin.go` — `OnActivate`, `MessageHasBeenDeleted` (cleanup), with `defer recover()` around hooks to protect the plugin process.

**Packer (`tools/pack/pack.go`)** — a tiny Go program that builds the final `.tar.gz`. It exists because Windows `bsdtar` cannot set Unix execute bits when archiving from NTFS, which produced `fork/exec ... permission denied` errors on Linux. The Go packer writes the tar headers directly with `mode 0755` for anything under `server/dist/` and `0644` for the rest.

---

## Configuration

There are no plugin settings to configure — install and enable. Authorization is enforced server-side: any channel member can record a read or fetch the readers list (the webapp only displays ticks on the requester's own posts).

### Privacy notes

- Only the **sender** sees the ✓✓ ticks on their own messages; recipients never see them on other people's posts.
- The popover shows username/avatar/timestamp of who read each message — same level of detail as WhatsApp.
- WebSocket events are broadcast channel-wide. The webapp filters client-side so only the sender's own posts are decorated. A determined snooper with DevTools could read the raw events for the channel they're in — if you need stricter privacy, restrict `broadcastReceipt` to `WebsocketBroadcast{UserId: post.UserId}` in `server/api.go`.

---

## Diagnostic / debug

The plugin emits verbose `[RR]` lines to its own stderr (visible in Mattermost server logs) covering every request — useful when something doesn't behave. On the webapp side a debug logger is available via `window.__readReceipts`:

```javascript
window.__readReceipts.scan()        // dump found post elements
window.__readReceipts.state()       // current user, post count, receipts cache
window.__readReceipts.dumpRandomPost()  // outerHTML of one post — for selector debugging
```

Console logging is on by default in this build; disable with `window.__readReceiptsDebugOff = true`.

To check which build is actually deployed:

```javascript
fetch('/plugins/com.mattermost.read-receipts/api/v1/version',{credentials:'same-origin'})
    .then(r => r.json()).then(console.log)
// → {build: "...", policy: "channel-member"}
```

To stream server-side logs from Docker:

```bash
docker logs -f $(docker ps --filter "ancestor=mattermost/mattermost-preview" -q) 2>&1 \
    | grep -E "\[RR\]|gob:"
```

---

## Known limitations

- **Messages posted before the plugin was enabled** have no recorded readers — receipts only accumulate from install time onward.
- If the **sender is offline** when a recipient reads, the live WebSocket event is lost. The sender's tick stays gray until the next refresh, after which `getReaders` fetches the actual count from KV.
- Per-post receipt cap of **5,000 readers** (`maxReadersPerPost` in `server/api.go`). Channels larger than that just stop accumulating — the existing ticks remain correct.
- Server-side mutex is global (`p.storeMu`). At very high throughput (>50 marks/sec sustained) you may want sharded mutexes; for typical team usage it's fine.
- No CSRF token validation beyond what Mattermost's middleware enforces. The plugin's own session check (`Mattermost-User-Id` header) is sufficient for the threat model (an attacker could at worst mark random posts read on the victim's behalf, which is harmless).

---

## Project layout

```
.
├── plugin.json                  Manifest
├── go.mod / go.sum              Server-side Go dependencies
├── build.ps1                    Windows build script (cross-compiles + packs)
├── server/
│   ├── main.go                  plugin.ClientMain entry point
│   ├── plugin.go                MattermostPlugin + lifecycle hooks
│   └── api.go                   HTTP API + KV access + WS broadcast
├── tools/pack/pack.go           Custom tar packer (handles Unix +x bits on NTFS)
└── webapp/
    ├── package.json             React 17 + react-redux 7 (externals)
    ├── webpack.config.js
    ├── tsconfig.json
    └── src/
        ├── index.tsx            Plugin entry point + ErrorBoundary
        ├── manifest.ts          Plugin ID, API URL, WS event name
        ├── client.ts            HTTP client (CSRF token, sanitizers)
        ├── debug.ts             Logging helpers
        └── components/
            └── read_receipt.tsx Main React component
```

---

## Contributing

Issues and PRs welcome. If you're submitting a fix, please bump the `buildTag` constant in `server/api.go` so deployed builds can be identified via the version endpoint.

## License

No license declared yet. Until one is added, all rights reserved by the author.
