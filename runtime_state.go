package main

import (
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/zytyan/suppbot/qbit"
)

type RuntimeTorrent struct {
	Hash       string    `json:"hash"`
	Name       string    `json:"name,omitempty"`
	Phase      string    `json:"phase"`
	Progress   float64   `json:"progress"`
	State      string    `json:"state,omitempty"`
	Downloaded int       `json:"downloaded,omitempty"`
	TotalSize  int       `json:"total_size,omitempty"`
	Speed      int       `json:"speed,omitempty"`
	ETA        int       `json:"eta,omitempty"`
	Seeds      int       `json:"seeds,omitempty"`
	Current    string    `json:"current,omitempty"`
	Completed  int       `json:"completed,omitempty"`
	Total      int       `json:"total,omitempty"`
	Retry      int       `json:"retry,omitempty"`
	Error      string    `json:"error,omitempty"`
	StartedAt  time.Time `json:"started_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type RuntimeSupp struct {
	ID             uint             `json:"id"`
	ArticleURLPath string           `json:"article_url_path"`
	Phase          string           `json:"phase"`
	Error          string           `json:"error,omitempty"`
	StartedAt      time.Time        `json:"started_at"`
	UpdatedAt      time.Time        `json:"updated_at"`
	Torrents       []RuntimeTorrent `json:"torrents"`
}

type RuntimeSnapshot struct {
	StartedAt       time.Time     `json:"started_at"`
	LastCrawlStart  *time.Time    `json:"last_crawl_start,omitempty"`
	LastCrawlEnd    *time.Time    `json:"last_crawl_end,omitempty"`
	NextCrawl       *time.Time    `json:"next_crawl,omitempty"`
	CrawlRunning    bool          `json:"crawl_running"`
	LastCrawlError  string        `json:"last_crawl_error,omitempty"`
	TorrentCacheAt  *time.Time    `json:"torrent_cache_at,omitempty"`
	TorrentCacheErr string        `json:"torrent_cache_error,omitempty"`
	MaxConcurrent   int           `json:"max_concurrent"`
	Running         []RuntimeSupp `json:"running"`
}

type runtimeSuppState struct {
	ID             uint
	ArticleURLPath string
	Phase          string
	Error          string
	StartedAt      time.Time
	UpdatedAt      time.Time
	Torrents       map[string]*RuntimeTorrent
}

var runtimeState = struct {
	sync.RWMutex
	startedAt       time.Time
	lastCrawlStart  *time.Time
	lastCrawlEnd    *time.Time
	nextCrawl       *time.Time
	crawlRunning    bool
	lastCrawlError  string
	torrentCacheErr string
	running         map[string]*runtimeSuppState
}{startedAt: time.Now(), running: make(map[string]*runtimeSuppState)}

func trackCrawlStart() {
	now := time.Now()
	runtimeState.Lock()
	runtimeState.lastCrawlStart = &now
	runtimeState.crawlRunning = true
	runtimeState.lastCrawlError = ""
	runtimeState.Unlock()
}

func trackCrawlEnd(err error, interval time.Duration) {
	now, next := time.Now(), time.Now().Add(interval)
	runtimeState.Lock()
	runtimeState.lastCrawlEnd = &now
	runtimeState.nextCrawl = &next
	runtimeState.crawlRunning = false
	if err != nil {
		runtimeState.lastCrawlError = err.Error()
	}
	runtimeState.Unlock()
}

func trackSuppStart(supp *Supp, phase string) {
	if supp.ArticleUrlPath == "" {
		return
	}
	now := time.Now()
	runtimeState.Lock()
	runtimeState.running[supp.ArticleUrlPath] = &runtimeSuppState{
		ID: supp.ID, ArticleURLPath: supp.ArticleUrlPath, Phase: phase,
		StartedAt: now, UpdatedAt: now, Torrents: make(map[string]*RuntimeTorrent),
	}
	runtimeState.Unlock()
}

func trackSuppPhase(supp *Supp, phase string, err error) {
	if supp.ArticleUrlPath == "" {
		return
	}
	now := time.Now()
	runtimeState.Lock()
	s := runtimeState.running[supp.ArticleUrlPath]
	if s == nil {
		s = &runtimeSuppState{ID: supp.ID, ArticleURLPath: supp.ArticleUrlPath, StartedAt: now, Torrents: make(map[string]*RuntimeTorrent)}
		runtimeState.running[supp.ArticleUrlPath] = s
	}
	s.Phase, s.UpdatedAt = phase, now
	if err != nil {
		s.Error = err.Error()
	}
	runtimeState.Unlock()
}

func trackSuppDone(supp *Supp, err error) {
	if supp.ArticleUrlPath == "" {
		return
	}
	trackSuppPhase(supp, "完成", err)
	runtimeState.Lock()
	delete(runtimeState.running, supp.ArticleUrlPath)
	runtimeState.Unlock()
}

func trackTorrent(supp *Supp, hash, phase string, torrent *qbit.Torrent) {
	if supp.ArticleUrlPath == "" {
		return
	}
	now := time.Now()
	runtimeState.Lock()
	s := runtimeState.running[supp.ArticleUrlPath]
	if s == nil {
		s = &runtimeSuppState{ID: supp.ID, ArticleURLPath: supp.ArticleUrlPath, Phase: "处理 torrent", StartedAt: now, Torrents: make(map[string]*RuntimeTorrent)}
		runtimeState.running[supp.ArticleUrlPath] = s
	}
	t := s.Torrents[hash]
	if t == nil {
		t = &RuntimeTorrent{Hash: hash, StartedAt: now}
		s.Torrents[hash] = t
	}
	t.Phase, t.UpdatedAt = phase, now
	if torrent != nil {
		t.Name, t.Progress, t.State = torrent.Name, torrent.Progress, torrent.State
		t.Downloaded, t.TotalSize, t.Speed, t.ETA, t.Seeds = torrent.Downloaded, torrent.TotalSize, torrent.DlSpeed, torrent.Eta, torrent.NumSeeds
	}
	s.UpdatedAt = now
	runtimeState.Unlock()
}

func trackTorrentWork(supp *Supp, hash, phase, current string, completed, total, retry int, progress float64, err error) {
	if supp.ArticleUrlPath == "" {
		return
	}
	trackTorrent(supp, hash, phase, nil)
	runtimeState.Lock()
	t := runtimeState.running[supp.ArticleUrlPath].Torrents[hash]
	t.Current = ""
	if current != "" {
		t.Current = filepath.Base(current)
	}
	t.Completed, t.Total, t.Retry = completed, total, retry
	if progress >= 0 {
		t.Progress = progress
	}
	if err != nil {
		t.Error = err.Error()
	}
	runtimeState.Unlock()
}

func runtimeSnapshot() RuntimeSnapshot {
	runtimeState.RLock()
	snap := RuntimeSnapshot{StartedAt: runtimeState.startedAt, LastCrawlStart: runtimeState.lastCrawlStart,
		LastCrawlEnd: runtimeState.lastCrawlEnd, NextCrawl: runtimeState.nextCrawl,
		CrawlRunning: runtimeState.crawlRunning, LastCrawlError: runtimeState.lastCrawlError,
		TorrentCacheErr: runtimeState.torrentCacheErr, MaxConcurrent: 2}
	for _, source := range runtimeState.running {
		s := RuntimeSupp{ID: source.ID, ArticleURLPath: source.ArticleURLPath, Phase: source.Phase,
			Error: source.Error, StartedAt: source.StartedAt, UpdatedAt: source.UpdatedAt}
		for _, torrent := range source.Torrents {
			s.Torrents = append(s.Torrents, *torrent)
		}
		sort.Slice(s.Torrents, func(i, j int) bool { return s.Torrents[i].Hash < s.Torrents[j].Hash })
		snap.Running = append(snap.Running, s)
	}
	runtimeState.RUnlock()
	cachedTorrents.mu.RLock()
	if !cachedTorrents.lastUpdate.IsZero() {
		at := cachedTorrents.lastUpdate
		snap.TorrentCacheAt = &at
	}
	cachedTorrents.mu.RUnlock()
	sort.Slice(snap.Running, func(i, j int) bool { return snap.Running[i].StartedAt.Before(snap.Running[j].StartedAt) })
	return snap
}
