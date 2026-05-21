package main

import (
	"sync"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

type Plugin struct {
	plugin.MattermostPlugin

	storeMu sync.Mutex
}

func (p *Plugin) OnActivate() error {
	return nil
}

func (p *Plugin) MessageHasBeenDeleted(c *plugin.Context, post *model.Post) {
	defer recoverHook("MessageHasBeenDeleted", p)
	if post == nil || post.Id == "" {
		return
	}
	if p.API == nil {
		return
	}
	_ = p.API.KVDelete(receiptKey(post.Id))
}

func recoverHook(name string, p *Plugin) {
	if r := recover(); r != nil {
		if p != nil && p.API != nil {
			p.API.LogError("plugin hook panic recovered", "hook", name, "panic", r)
		}
	}
}
