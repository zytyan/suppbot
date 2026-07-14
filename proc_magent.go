package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/zytyan/suppbot/qbit"
	"log"
	"strings"
	"sync"
	"time"
)

var cachedTorrents struct {
	mu         sync.RWMutex
	refreshMu  sync.Mutex
	torrents   map[string]qbit.Torrent
	lastUpdate time.Time
}

var (
	getTorrents         = func() ([]qbit.Torrent, error) { return qClient.GetTorrents() }
	torrentCacheTTL     = 5 * time.Second
	magnetPollInterval  = 10 * time.Second
	maxTorrentMisses    = 20
	uploadTorrentVideos = uploadVideos
	uploadTorrentFiles  = UploadRawFiles
)

func getTorrentsCached() (map[string]qbit.Torrent, error) {
	cachedTorrents.mu.RLock()
	if time.Since(cachedTorrents.lastUpdate) < torrentCacheTTL {
		cachedTorrents.mu.RUnlock()
		return cachedTorrents.torrents, nil
	}
	cachedTorrents.mu.RUnlock()
	cachedTorrents.refreshMu.Lock()
	defer cachedTorrents.refreshMu.Unlock()
	cachedTorrents.mu.RLock()
	if time.Since(cachedTorrents.lastUpdate) < torrentCacheTTL {
		defer cachedTorrents.mu.RUnlock()
		return cachedTorrents.torrents, nil
	}
	cachedTorrents.mu.RUnlock()
	torrents, err := getTorrents()
	if err != nil {
		runtimeState.Lock()
		runtimeState.torrentCacheErr = err.Error()
		runtimeState.Unlock()
		return nil, err
	}
	cachedTorrents.mu.Lock()
	defer cachedTorrents.mu.Unlock()
	cachedTorrents.lastUpdate = time.Now()
	res := make(map[string]qbit.Torrent, len(torrents)*2)
	for _, t := range torrents {
		if hash := strings.ToLower(t.Hash); hash != "" {
			res[hash] = t
		}
		if hash := strings.ToLower(t.InfoHashV1); hash != "" {
			res[hash] = t
		}
	}
	cachedTorrents.torrents = res
	runtimeState.Lock()
	runtimeState.torrentCacheErr = ""
	runtimeState.Unlock()
	return res, nil
}

func DownloadMagnet(hash []string) error {
	torrents, err := qClient.GetTorrents()
	if err != nil {
		return err
	}
	// 删除已经存在的hash，否则会报错
	ts := make(map[string]struct{}, len(torrents))
	for _, t := range torrents {
		if t.Hash != "" {
			ts[strings.ToLower(t.Hash)] = struct{}{}
		}
		if t.InfoHashV1 != "" {
			ts[strings.ToLower(t.InfoHashV1)] = struct{}{}
		}
	}
	newHash := make([]string, 0, len(hash))
	for _, h := range hash {
		if _, ok := ts[strings.ToLower(h)]; !ok {
			log.Printf("hash = %s\n", h)
			newHash = append(newHash, h)
		}
	}
	if len(newHash) == 0 {
		return nil
	}
	return qClient.DownloadMagnetUrls(newHash)
}

func WaitAndProcMagnet(ctx context.Context, supp *Supp, hash string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("supp %s, hash %s, panic: %v", supp.ArticleUrlPath, hash, r)
			log.Println(r)
		}
	}()
	countNotInTorrents := 0
	hash = strings.ToLower(hash)
	trackTorrent(supp, hash, "等待 qBittorrent", nil)
	torrentRecord, err := getSuppTorrent(supp, hash)
	if err != nil {
		return err
	}
	if err := setTorrentStatus(torrentRecord, TorrentStatusProcessing, nil); err != nil {
		return err
	}
	defer func() {
		status := TorrentStatusDone
		if err != nil {
			status = TorrentStatusError
		}
		if statusErr := setTorrentStatus(torrentRecord, status, err); statusErr != nil {
			err = errors.Join(err, statusErr)
		}
		if err != nil {
			trackTorrentWork(supp, hash, "失败", "", 0, 0, 0, -1, err)
		} else {
			trackTorrentWork(supp, hash, "完成", "", 1, 1, 0, 1, nil)
		}
	}()
	for {
		torrents, err := getTorrentsCached()
		if err != nil {
			log.Println(err)
			return err
		}
		torrent, ok := torrents[hash]
		if !ok {
			countNotInTorrents++
			log.Printf("magnet %s not in torrents, countNotInTorrents: %d", hash, countNotInTorrents)
			if countNotInTorrents >= maxTorrentMisses {
				return fmt.Errorf("magnet %s not found in qBittorrent after %d checks", hash, countNotInTorrents)
			}
			trackTorrentWork(supp, hash, "等待 qBittorrent", "", countNotInTorrents, maxTorrentMisses, 0, 0, nil)
			if err := waitForNextMagnetPoll(ctx); err != nil {
				return err
			}
			continue
		}
		countNotInTorrents = 0
		trackTorrent(supp, hash, "下载", &torrent)
		if torrent.Progress >= 1 {
			trackTorrent(supp, hash, "处理下载内容", &torrent)
			videoErr := uploadTorrentVideos(&torrent, supp, torrentRecord)
			filesErr := uploadTorrentFiles(&torrent, supp, torrentRecord)
			return errors.Join(videoErr, filesErr)
		}
		if err := waitForNextMagnetPoll(ctx); err != nil {
			return err
		}
	}
}

func waitForNextMagnetPoll(ctx context.Context) error {
	timer := time.NewTimer(magnetPollInterval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
