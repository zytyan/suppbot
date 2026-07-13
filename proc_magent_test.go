package main

import (
	"context"
	"errors"
	"github.com/zytyan/suppbot/qbit"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTypeMagnetsEmptyDatabaseValue(t *testing.T) {
	var magnets TypeMagnets
	require.NoError(t, magnets.Scan(""))
	require.Empty(t, magnets)

	require.NoError(t, magnets.Scan("abc,, def "))
	require.Equal(t, TypeMagnets{"abc", "def"}, magnets)
	value, err := TypeMagnets{"abc", "", " def "}.Value()
	require.NoError(t, err)
	require.Equal(t, "abc,def", value)
}

func resetTorrentCacheForTest() {
	cachedTorrents.mu.Lock()
	cachedTorrents.torrents = nil
	cachedTorrents.lastUpdate = time.Time{}
	cachedTorrents.mu.Unlock()
}

func TestWaitAndProcMagnetAppearsThenUploads(t *testing.T) {
	originalGet := getTorrents
	originalTTL := torrentCacheTTL
	originalPoll := magnetPollInterval
	originalMisses := maxTorrentMisses
	originalVideos := uploadTorrentVideos
	originalFiles := uploadTorrentFiles
	t.Cleanup(func() {
		getTorrents = originalGet
		torrentCacheTTL = originalTTL
		magnetPollInterval = originalPoll
		maxTorrentMisses = originalMisses
		uploadTorrentVideos = originalVideos
		uploadTorrentFiles = originalFiles
		resetTorrentCacheForTest()
	})

	resetTorrentCacheForTest()
	torrentCacheTTL = 0
	magnetPollInterval = time.Millisecond
	maxTorrentMisses = 4
	calls := 0
	getTorrents = func() ([]qbit.Torrent, error) {
		calls++
		if calls < 3 {
			return nil, nil
		}
		return []qbit.Torrent{{Hash: "ABCDEF", Progress: 1, ContentPath: "/tmp/test"}}, nil
	}
	videoUploads := 0
	rawUploads := 0
	uploadTorrentVideos = func(*qbit.Torrent, *Supp) error { videoUploads++; return nil }
	uploadTorrentFiles = func(*qbit.Torrent, *Supp) error { rawUploads++; return nil }

	err := WaitAndProcMagnet(context.Background(), &Supp{ArticleUrlPath: "/test"}, "abcdef")
	require.NoError(t, err)
	require.Equal(t, 3, calls)
	require.Equal(t, 1, videoUploads)
	require.Equal(t, 1, rawUploads)
}

func TestWaitAndProcMagnetMatchesInfoHashV1CaseInsensitive(t *testing.T) {
	originalGet := getTorrents
	originalTTL := torrentCacheTTL
	originalVideos := uploadTorrentVideos
	originalFiles := uploadTorrentFiles
	t.Cleanup(func() {
		getTorrents = originalGet
		torrentCacheTTL = originalTTL
		uploadTorrentVideos = originalVideos
		uploadTorrentFiles = originalFiles
		resetTorrentCacheForTest()
	})

	resetTorrentCacheForTest()
	torrentCacheTTL = 0
	getTorrents = func() ([]qbit.Torrent, error) {
		return []qbit.Torrent{{InfoHashV1: "A1B2C3", Progress: 1}}, nil
	}
	uploadTorrentVideos = func(*qbit.Torrent, *Supp) error { return nil }
	uploadTorrentFiles = func(*qbit.Torrent, *Supp) error { return nil }

	require.NoError(t, WaitAndProcMagnet(context.Background(), &Supp{}, "a1b2c3"))
}

func TestWaitAndProcMagnetMissingReturnsError(t *testing.T) {
	originalGet := getTorrents
	originalTTL := torrentCacheTTL
	originalPoll := magnetPollInterval
	originalMisses := maxTorrentMisses
	t.Cleanup(func() {
		getTorrents = originalGet
		torrentCacheTTL = originalTTL
		magnetPollInterval = originalPoll
		maxTorrentMisses = originalMisses
		resetTorrentCacheForTest()
	})

	resetTorrentCacheForTest()
	torrentCacheTTL = 0
	magnetPollInterval = time.Millisecond
	maxTorrentMisses = 2
	getTorrents = func() ([]qbit.Torrent, error) { return nil, nil }

	err := WaitAndProcMagnet(context.Background(), &Supp{}, "missing")
	require.ErrorContains(t, err, "not found in qBittorrent")
}

func TestWaitAndProcMagnetPropagatesUploadError(t *testing.T) {
	originalGet := getTorrents
	originalTTL := torrentCacheTTL
	originalVideos := uploadTorrentVideos
	originalFiles := uploadTorrentFiles
	t.Cleanup(func() {
		getTorrents = originalGet
		torrentCacheTTL = originalTTL
		uploadTorrentVideos = originalVideos
		uploadTorrentFiles = originalFiles
		resetTorrentCacheForTest()
	})

	resetTorrentCacheForTest()
	torrentCacheTTL = 0
	getTorrents = func() ([]qbit.Torrent, error) {
		return []qbit.Torrent{{Hash: "hash", Progress: 1}}, nil
	}
	uploadTorrentVideos = func(*qbit.Torrent, *Supp) error { return errors.New("video failed") }
	rawCalled := false
	uploadTorrentFiles = func(*qbit.Torrent, *Supp) error { rawCalled = true; return nil }

	err := WaitAndProcMagnet(context.Background(), &Supp{}, "hash")
	require.EqualError(t, err, "video failed")
	require.True(t, rawCalled)
}

func TestWaitAndProcMagnetJoinsVideoAndRawErrors(t *testing.T) {
	originalGet := getTorrents
	originalTTL := torrentCacheTTL
	originalVideos := uploadTorrentVideos
	originalFiles := uploadTorrentFiles
	t.Cleanup(func() {
		getTorrents = originalGet
		torrentCacheTTL = originalTTL
		uploadTorrentVideos = originalVideos
		uploadTorrentFiles = originalFiles
		resetTorrentCacheForTest()
	})

	resetTorrentCacheForTest()
	torrentCacheTTL = 0
	getTorrents = func() ([]qbit.Torrent, error) {
		return []qbit.Torrent{{Hash: "hash", Progress: 1}}, nil
	}
	uploadTorrentVideos = func(*qbit.Torrent, *Supp) error { return errors.New("video failed") }
	uploadTorrentFiles = func(*qbit.Torrent, *Supp) error { return errors.New("raw failed") }

	err := WaitAndProcMagnet(context.Background(), &Supp{}, "hash")
	require.ErrorContains(t, err, "video failed")
	require.ErrorContains(t, err, "raw failed")
}

func TestWaitAndProcMagnetHonorsContext(t *testing.T) {
	originalGet := getTorrents
	originalTTL := torrentCacheTTL
	originalPoll := magnetPollInterval
	t.Cleanup(func() {
		getTorrents = originalGet
		torrentCacheTTL = originalTTL
		magnetPollInterval = originalPoll
		resetTorrentCacheForTest()
	})

	resetTorrentCacheForTest()
	torrentCacheTTL = 0
	magnetPollInterval = time.Hour
	getTorrents = func() ([]qbit.Torrent, error) { return nil, nil }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	require.ErrorIs(t, WaitAndProcMagnet(ctx, &Supp{}, "hash"), context.Canceled)
}

func TestUploadVideoWithRetry(t *testing.T) {
	attempts := 0
	var waits []time.Duration
	err := uploadVideoWithRetry("video.mp4", &Supp{}, func(string, *Supp) error {
		attempts++
		if attempts < 3 {
			return errors.New("Too Many Requests: retry after 8")
		}
		return nil
	}, func(wait time.Duration) { waits = append(waits, wait) })

	require.NoError(t, err)
	require.Equal(t, 3, attempts)
	require.Equal(t, []time.Duration{9 * time.Second, 9 * time.Second}, waits)
}

func TestUploadVideoWithRetryPermanentError(t *testing.T) {
	attempts := 0
	err := uploadVideoWithRetry("video.mp4", &Supp{}, func(string, *Supp) error {
		attempts++
		return errors.New("FILE_PARTS_INVALID")
	}, func(time.Duration) { t.Fatal("must not sleep") })

	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "FILE_PARTS_INVALID"))
	require.Equal(t, 1, attempts)
}
