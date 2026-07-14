package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/zytyan/suppbot/qbit"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestAdminListenAddress(t *testing.T) {
	t.Setenv("SUPPBOT_ADMIN_LISTEN", "")
	require.Equal(t, "127.0.0.1:9001", adminListenAddress())
	t.Setenv("SUPPBOT_ADMIN_LISTEN", "127.0.0.1:19001")
	require.Equal(t, "127.0.0.1:19001", adminListenAddress())
}

func TestAdminAssetsAreEmbedded(t *testing.T) {
	for _, name := range []string{"web/templates/layout.html", "web/static/admin.css", "web/static/admin.js"} {
		content, err := adminAssets.ReadFile(name)
		require.NoError(t, err)
		require.NotEmpty(t, content)
	}
}

func TestAdminDashboardRendersEmbeddedPage(t *testing.T) {
	originalDB := db
	t.Cleanup(func() { db = originalDB })
	var err error
	db, err = gorm.Open(sqlite.Open("file:admin-render-test?mode=memory&cache=shared"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Supp{}, &SuppTorrent{}, &SendRecord{}))
	supp := Supp{ArticleUrlPath: "/wp/render-test.html", Status: "done", Magnets: TypeMagnets{"abcdef"}}
	require.NoError(t, db.Create(&supp).Error)
	handler, err := newAdminHandler()
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, response.Body.String(), "运行总览")
	require.Contains(t, response.Body.String(), adminBasePath+"/static/admin.css")
	require.Contains(t, response.Header().Get("Content-Security-Policy"), "default-src 'self'")

	cachedTorrents.mu.Lock()
	cachedTorrents.lastUpdate = time.Now()
	cachedTorrents.torrents = map[string]qbit.Torrent{}
	cachedTorrents.mu.Unlock()
	detailReq := httptest.NewRequest(http.MethodGet, "/supps/"+strconv.FormatUint(uint64(supp.ID), 10), nil)
	detailResponse := httptest.NewRecorder()
	handler.ServeHTTP(detailResponse, detailReq)
	require.Equal(t, http.StatusOK, detailResponse.Code)
	require.Contains(t, detailResponse.Body.String(), supp.ArticleUrlPath)
	require.Contains(t, detailResponse.Body.String(), "abcdef")
}

func TestUpdateStatusValidationAndWrite(t *testing.T) {
	originalDB := db
	t.Cleanup(func() { db = originalDB })
	var err error
	db, err = gorm.Open(sqlite.Open("file::memory:?cache=shared"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&Supp{}))
	supp := Supp{ArticleUrlPath: "/wp/admin-test.html", Status: "error"}
	require.NoError(t, db.Create(&supp).Error)

	app := &adminApp{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /supps/{id}/status", app.updateStatus)
	request := func(status, token string) *httptest.ResponseRecorder {
		form := url.Values{"status": {status}, "csrf_token": {token}}
		req := httptest.NewRequest(http.MethodPost, "/supps/"+strconv.FormatUint(uint64(supp.ID), 10)+"/status", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.AddCookie(&http.Cookie{Name: "suppbot_csrf", Value: token})
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		return response
	}

	require.Equal(t, http.StatusBadRequest, request("invalid", "01234567890123456789012345678901").Code)
	response := request("done", "01234567890123456789012345678901")
	require.Equal(t, http.StatusSeeOther, response.Code)
	require.NoError(t, db.First(&supp, supp.ID).Error)
	require.Equal(t, "done", supp.Status)
}

func TestRuntimeSnapshotCopiesState(t *testing.T) {
	supp := &Supp{ArticleUrlPath: "/wp/runtime-test.html"}
	trackSuppStart(supp, "测试")
	trackTorrentWork(supp, "abcdef", "下载", "movie.mp4", 1, 2, 0, 0.5, nil)
	t.Cleanup(func() { trackSuppDone(supp, nil) })

	snapshot := runtimeSnapshot()
	require.NotEmpty(t, snapshot.Running)
	require.Equal(t, 2, snapshot.MaxConcurrent)
	found := false
	for _, running := range snapshot.Running {
		if running.ArticleURLPath == supp.ArticleUrlPath {
			found = true
			require.Equal(t, 0.5, running.Torrents[0].Progress)
		}
	}
	require.True(t, found)
}
