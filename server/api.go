package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const (
	kvPrefixReceipt    = "receipt:"
	wsEventReadReceipt = "read_receipt"

	maxBatchSize      = 200
	maxReadersPerPost = 5000
	maxBodyBytes      = 64 * 1024

	// Build tag bumped on every meaningful policy/protocol change so the
	// webapp and the user can verify which build is actually deployed.
	buildTag = "2026-07-28-inline-thread-receipts"
)

// dbg writes a line to the plugin process stderr. Mattermost forwards it to
// its own log as a "plugin_stderr" line. This works even when p.API RPC
// calls are dead, which is exactly the situation we need to diagnose.
func dbg(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[RR] "+format+"\n", args...)
}

type ReadReceipt struct {
	UserID string `json:"user_id"`
	ReadAt int64  `json:"read_at"`
}

type readersResponse struct {
	PostID  string        `json:"post_id"`
	Readers []ReadReceipt `json:"readers"`
}

type readBatchRequest struct {
	PostIDs   []string `json:"post_ids"`
	ChannelID string   `json:"channel_id"`
}

func receiptKey(postID string) string {
	return kvPrefixReceipt + postID
}

func (p *Plugin) ServeHTTP(c *plugin.Context, w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			dbg("ServeHTTP panic recovered: %v path=%s", rec, r.URL.Path)
			http.Error(w, "internal error", http.StatusInternalServerError)
		}
	}()

	userID := r.Header.Get("Mattermost-User-Id")
	dbg("HTTP %s %s user=%s build=%s", r.Method, r.URL.Path, userID, buildTag)

	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/read_batch":
		p.handleReadBatch(w, r, userID)
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/readers":
		p.handleGetReaders(w, r, userID)
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/version":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"build":  buildTag,
			"policy": "channel-member",
		})
	default:
		http.NotFound(w, r)
	}
}

func (p *Plugin) handleReadBatch(w http.ResponseWriter, r *http.Request, userID string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var req readBatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		dbg("read_batch decode error: %v", err)
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(req.PostIDs) > maxBatchSize {
		req.PostIDs = req.PostIDs[:maxBatchSize]
	}

	dbg("read_batch user=%s posts=%d channel_hint=%s", userID, len(req.PostIDs), req.ChannelID)

	now := time.Now().UnixMilli()
	marked := 0
	getPostFailed := 0
	notMember := 0
	selfPost := 0
	alreadyRead := 0

	for _, postID := range req.PostIDs {
		if postID == "" {
			continue
		}

		var channelID string
		var postAuthor string

		post, appErr := p.API.GetPost(postID)
		if appErr != nil || post == nil {
			getPostFailed++
			if req.ChannelID == "" {
				dbg("read_batch GetPost FAILED post=%s err=%v (no channel_hint to fall back on)", postID, appErr)
				continue
			}
			// Fall back to channel hint from the webapp.
			channelID = req.ChannelID
			postAuthor = ""
			dbg("read_batch GetPost failed, falling back to channel_hint post=%s channel=%s err=%v", postID, channelID, appErr)
		} else {
			channelID = post.ChannelId
			postAuthor = post.UserId
		}

		if postAuthor != "" && postAuthor == userID {
			selfPost++
			continue
		}

		if _, mErr := p.API.GetChannelMember(channelID, userID); mErr != nil {
			notMember++
			dbg("read_batch GetChannelMember FAILED user=%s channel=%s err=%v", userID, channelID, mErr)
			continue
		}

		p.storeMu.Lock()
		readers, _ := p.loadReceipts(postID)
		if hasReader(readers, userID) {
			alreadyRead++
		} else if len(readers) < maxReadersPerPost {
			readers = append(readers, ReadReceipt{UserID: userID, ReadAt: now})
			if err := p.saveReceipts(postID, readers); err == nil {
				p.broadcastReceipt(channelID, postID, readers)
				marked++
				dbg("read_batch MARKED post=%s reader=%s channel=%s readers_now=%d", postID, userID, channelID, len(readers))
			} else {
				dbg("read_batch saveReceipts FAILED post=%s err=%v", postID, err)
			}
		}
		p.storeMu.Unlock()
	}

	dbg("read_batch DONE user=%s marked=%d already=%d self=%d getpost_failed=%d not_member=%d", userID, marked, alreadyRead, selfPost, getPostFailed, notMember)

	w.WriteHeader(http.StatusNoContent)
}

func (p *Plugin) handleGetReaders(w http.ResponseWriter, r *http.Request, userID string) {
	postID := r.URL.Query().Get("post_id")
	channelHint := r.URL.Query().Get("channel_id")
	if postID == "" || len(postID) > 64 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	dbg("getReaders user=%s post=%s channel_hint=%s", userID, postID, channelHint)

	var channelID string
	post, appErr := p.API.GetPost(postID)
	if appErr != nil || post == nil {
		if channelHint == "" {
			dbg("getReaders 403 GetPost FAILED post=%s user=%s err=%v (no channel_hint)", postID, userID, appErr)
			http.Error(w, "forbidden: post lookup failed", http.StatusForbidden)
			return
		}
		channelID = channelHint
		dbg("getReaders GetPost failed, using channel_hint=%s err=%v", channelID, appErr)
	} else {
		channelID = post.ChannelId
	}

	if _, mErr := p.API.GetChannelMember(channelID, userID); mErr != nil {
		dbg("getReaders 403 GetChannelMember FAILED user=%s channel=%s err=%v", userID, channelID, mErr)
		http.Error(w, "forbidden: not a channel member", http.StatusForbidden)
		return
	}

	readers, kvErr := p.loadReceipts(postID)
	if kvErr != nil {
		dbg("getReaders KVGet error post=%s err=%v", postID, kvErr)
	}
	if readers == nil {
		readers = []ReadReceipt{}
	}

	dbg("getReaders OK user=%s post=%s readers=%d", userID, postID, len(readers))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(readersResponse{PostID: postID, Readers: readers})
}

func (p *Plugin) loadReceipts(postID string) ([]ReadReceipt, error) {
	b, err := p.API.KVGet(receiptKey(postID))
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return []ReadReceipt{}, nil
	}
	var receipts []ReadReceipt
	if jErr := json.Unmarshal(b, &receipts); jErr != nil {
		return []ReadReceipt{}, nil
	}
	return receipts, nil
}

func (p *Plugin) saveReceipts(postID string, receipts []ReadReceipt) error {
	sort.Slice(receipts, func(i, j int) bool {
		return receipts[i].ReadAt < receipts[j].ReadAt
	})
	b, err := json.Marshal(receipts)
	if err != nil {
		return err
	}
	if appErr := p.API.KVSet(receiptKey(postID), b); appErr != nil {
		return appErr
	}
	return nil
}

func hasReader(rs []ReadReceipt, userID string) bool {
	for _, r := range rs {
		if r.UserID == userID {
			return true
		}
	}
	return false
}

func (p *Plugin) broadcastReceipt(channelID, postID string, readers []ReadReceipt) {
	// CRITICAL: PublishWebSocketEvent's payload is serialized through Go's
	// encoding/gob over the plugin RPC. gob will not encode any concrete type
	// inside an interface{} unless it was registered with gob.Register() —
	// and the Mattermost plugin SDK only pre-registers primitives (string,
	// int, bool, float64). ANY slice or map nested inside the payload —
	// []ReadReceipt, []map[string]interface{}, even []string — explodes with
	// "gob: type not registered" and *permanently kills the plugin's RPC
	// connection* for the rest of the process's life. Every subsequent
	// p.API.* call then returns "connection is shut down".
	//
	// The only safe leaf types are primitives. So we serialize the readers
	// list to JSON and ship it as a single string; the webapp parses it.
	readersJSON, err := json.Marshal(readers)
	if err != nil {
		return
	}
	p.API.PublishWebSocketEvent(
		wsEventReadReceipt,
		map[string]interface{}{
			"post_id":      postID,
			"readers_json": string(readersJSON),
		},
		&model.WebsocketBroadcast{ChannelId: channelID},
	)
}
