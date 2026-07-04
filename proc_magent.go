package main

import (
	"context"
	"fmt"
	"log"
	"main/qbit"
	"sync"
	"time"
)

var cachedTorrents struct {
	mu         sync.RWMutex
	torrents   map[string]qbit.Torrent
	lastUpdate time.Time
}

func getTorrentsCached() (map[string]qbit.Torrent, error) {
	cachedTorrents.mu.RLock()
	if time.Since(cachedTorrents.lastUpdate) < 5*time.Second {
		cachedTorrents.mu.RUnlock()
		return cachedTorrents.torrents, nil
	}
	cachedTorrents.mu.RUnlock()
	torrents, err := qClient.GetTorrents()
	if err != nil {
		return nil, err
	}
	cachedTorrents.mu.Lock()
	defer cachedTorrents.mu.Unlock()
	cachedTorrents.lastUpdate = time.Now()
	res := make(map[string]qbit.Torrent, len(torrents))
	for _, t := range torrents {
		res[t.Hash] = t
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
		ts[t.Hash] = struct{}{}
	}
	newHash := make([]string, 0, len(hash))
	for _, h := range hash {
		if _, ok := ts[h]; !ok {
			newHash = append(newHash, h)
		}
	}
	if len(newHash) == 0 {
		return nil
	}
	return qClient.DownloadMagnetUrls(newHash)
}

func WaitAndProcMagnet(ctx context.Context, manager *TaskManager, supp *Supp, hash string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("supp %s, hash %s, panic: %v", supp.ArticleUrlPath, hash, r)
			log.Println(r)
		}
	}()
	countNotInTorrents := 0
	for {
		torrents, err := getTorrentsCached()
		if err != nil {
			log.Println(err)
			return err
		}
		countNotInTorrents++
		torrent, ok := torrents[hash]
		if !ok {
			log.Printf("magnet %s not in torrents, countNotInTorrents: %d", hash, countNotInTorrents)
			if countNotInTorrents > 20 {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(10 * time.Second):
			}
			continue
		}
		countNotInTorrents = 0
		if manager != nil {
			manager.UpdateTaskProgress(supp, string(TaskDownloading), fmt.Sprintf("下载中 %.1f%% %s", torrent.Progress*100, torrent.Name), hash)
		}
		if torrent.Progress == 1 {
			if manager != nil {
				manager.UpdateTaskProgress(supp, string(TaskUploadingVideo), "下载完成，开始上传视频", hash)
			}
			if err := uploadVideos(manager, &torrent, supp); err != nil {
				return err
			}
			if manager != nil {
				manager.UpdateTaskProgress(supp, string(TaskUploadingRaw), "开始上传原始文件", hash)
			}
			err := UploadRawFiles(manager, &torrent, supp)
			if err == nil && manager != nil {
				manager.IncrementDoneMagnet(supp)
			}
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Second):
		}
	}
}
