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
	torrents, err := getTorrents()
	if err != nil {
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
			if err := waitForNextMagnetPoll(ctx); err != nil {
				return err
			}
			continue
		}
		countNotInTorrents = 0
		if torrent.Progress >= 1 {
			videoErr := uploadTorrentVideos(&torrent, supp)
			filesErr := uploadTorrentFiles(&torrent, supp)
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
