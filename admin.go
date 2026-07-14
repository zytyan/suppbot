package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/zytyan/suppbot/qbit"
	"gorm.io/gorm"
)

const adminBasePath = "/suppbot"

//go:embed web/templates/*.html web/static/*
var adminAssets embed.FS

type StatusCount struct {
	Status string
	Count  int64
}

type SuppListRow struct {
	ID             uint
	ArticleURLPath string
	Status         string
	UpdatedAt      time.Time
	Magnets        TypeMagnets
	TorrentCount   int64
	SendCount      int64
	ErrorCount     int64
}

type SuppDetail struct {
	Supp     Supp
	Torrents []TorrentDetail
	Sends    []SendRecord
}

type TorrentDetail struct {
	Record SuppTorrent
	Live   *qbit.Torrent
}

type adminPageData struct {
	Title                                        string
	BasePath                                     string
	CSRF                                         string
	View                                         string
	Runtime                                      RuntimeSnapshot
	SuppCounts, TorrentCounts, SendCounts        []StatusCount
	Rows                                         []SuppListRow
	Detail                                       *SuppDetail
	Query, SuppStatus, TorrentStatus, SendStatus string
	Page, TotalPages                             int
	Error, Notice                                string
}

type adminApp struct{ templates *template.Template }

func adminListenAddress() string {
	if value := strings.TrimSpace(os.Getenv("SUPPBOT_ADMIN_LISTEN")); value != "" {
		return value
	}
	return "127.0.0.1:9001"
}

func startAdminServer() error {
	listener, err := net.Listen("tcp", adminListenAddress())
	if err != nil {
		return fmt.Errorf("listen admin server: %w", err)
	}
	handler, err := newAdminHandler()
	if err != nil {
		_ = listener.Close()
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		log.Printf("suppbot admin listening on %s", listener.Addr())
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("admin server stopped: %v", serveErr)
		}
	}()
	return nil
}

func newAdminHandler() (http.Handler, error) {
	funcs := template.FuncMap{
		"pct":   func(v float64) string { return fmt.Sprintf("%.1f%%", v*100) },
		"bytes": humanBytes, "duration": humanDuration,
		"timefmt": formatTime,
		"shortHash": func(v string) string {
			if len(v) > 12 {
				return v[:12]
			}
			return v
		},
		"minus":       func(a, b int) int { return a - b },
		"plus":        func(a, b int) int { return a + b },
		"articleURL":  articleURL,
		"telegramURL": telegramURL,
	}
	tmpl, err := template.New("admin").Funcs(funcs).ParseFS(adminAssets, "web/templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parse admin templates: %w", err)
	}
	staticFS, err := fs.Sub(adminAssets, "web/static")
	if err != nil {
		return nil, err
	}
	app := &adminApp{templates: tmpl}
	mux := http.NewServeMux()
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	mux.HandleFunc("GET /", app.dashboard)
	mux.HandleFunc("GET /supps", app.suppList)
	mux.HandleFunc("GET /supps/{id}", app.suppDetail)
	mux.HandleFunc("POST /supps/{id}/status", app.updateStatus)
	mux.HandleFunc("GET /api/runtime", app.runtimeAPI)
	return securityHeaders(mux), nil
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func csrfToken(w http.ResponseWriter, r *http.Request) string {
	if cookie, err := r.Cookie("suppbot_csrf"); err == nil && len(cookie.Value) >= 32 {
		return cookie.Value
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	http.SetCookie(w, &http.Cookie{Name: "suppbot_csrf", Value: token, Path: adminBasePath + "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: 86400})
	return token
}

func validCSRF(r *http.Request) bool {
	cookie, err := r.Cookie("suppbot_csrf")
	if err != nil {
		return false
	}
	form := r.FormValue("csrf_token")
	return len(cookie.Value) == len(form) && subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(form)) == 1
}

func (a *adminApp) baseData(w http.ResponseWriter, r *http.Request, title, view string) adminPageData {
	return adminPageData{Title: title, BasePath: adminBasePath, CSRF: csrfToken(w, r), View: view, Runtime: runtimeSnapshot(), Page: 1, TotalPages: 1, Notice: r.URL.Query().Get("notice")}
}

func statusCounts(model any) []StatusCount {
	var result []StatusCount
	if err := db.Model(model).Select("status, count(*) as count").Where("deleted_at IS NULL").Group("status").Order("status").Scan(&result).Error; err != nil {
		log.Printf("admin status counts: %v", err)
	}
	return result
}

func (a *adminApp) dashboard(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data := a.baseData(w, r, "运行总览", "dashboard")
	data.SuppCounts, data.TorrentCounts, data.SendCounts = statusCounts(&Supp{}), statusCounts(&SuppTorrent{}), statusCounts(&SendRecord{})
	a.render(w, "layout.html", data)
}

func (a *adminApp) suppList(w http.ResponseWriter, r *http.Request) {
	data := a.baseData(w, r, "补档查询", "list")
	data.Query = strings.TrimSpace(r.URL.Query().Get("q"))
	data.SuppStatus = r.URL.Query().Get("status")
	data.TorrentStatus = r.URL.Query().Get("torrent_status")
	data.SendStatus = r.URL.Query().Get("send_status")
	data.Page, _ = strconv.Atoi(r.URL.Query().Get("page"))
	if data.Page < 1 {
		data.Page = 1
	}
	query := db.Model(&Supp{}).Where("supps.deleted_at IS NULL")
	if data.SuppStatus != "" {
		query = query.Where("supps.status = ?", data.SuppStatus)
	}
	if data.TorrentStatus != "" {
		query = query.Where("EXISTS (SELECT 1 FROM supp_torrents st WHERE st.supp_id=supps.id AND st.deleted_at IS NULL AND st.status=?)", data.TorrentStatus)
	}
	if data.SendStatus != "" {
		query = query.Where("EXISTS (SELECT 1 FROM supp_torrents st JOIN send_records sr ON sr.torrent_id=st.id AND sr.deleted_at IS NULL WHERE st.supp_id=supps.id AND st.deleted_at IS NULL AND sr.status=?)", data.SendStatus)
	}
	if data.Query != "" {
		like := "%" + data.Query + "%"
		query = query.Where("supps.article_url_path LIKE ? OR CAST(supps.id AS TEXT)=? OR EXISTS (SELECT 1 FROM supp_torrents st WHERE st.supp_id=supps.id AND st.deleted_at IS NULL AND (st.hash LIKE ? OR st.error LIKE ?)) OR EXISTS (SELECT 1 FROM supp_torrents st JOIN send_records sr ON sr.torrent_id=st.id AND sr.deleted_at IS NULL WHERE st.supp_id=supps.id AND st.deleted_at IS NULL AND (sr.file_name LIKE ? OR sr.source_path LIKE ? OR sr.error LIKE ?))", like, data.Query, like, like, like, like, like)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		data.Error = err.Error()
	}
	const pageSize = 50
	data.TotalPages = int((total + pageSize - 1) / pageSize)
	if data.TotalPages < 1 {
		data.TotalPages = 1
	}
	if data.Page > data.TotalPages {
		data.Page = data.TotalPages
	}
	err := query.Select(`supps.id, supps.article_url_path, supps.status, supps.updated_at, supps.magnets,
		(SELECT count(*) FROM supp_torrents st WHERE st.supp_id=supps.id AND st.deleted_at IS NULL) torrent_count,
		(SELECT count(*) FROM supp_torrents st JOIN send_records sr ON sr.torrent_id=st.id AND sr.deleted_at IS NULL WHERE st.supp_id=supps.id AND st.deleted_at IS NULL) send_count,
		(SELECT count(*) FROM supp_torrents st LEFT JOIN send_records sr ON sr.torrent_id=st.id AND sr.deleted_at IS NULL WHERE st.supp_id=supps.id AND st.deleted_at IS NULL AND (st.status='error' OR sr.status='failed')) error_count`).Order("supps.updated_at DESC").Limit(pageSize).Offset((data.Page - 1) * pageSize).Scan(&data.Rows).Error
	if err != nil {
		data.Error = err.Error()
	}
	data.SuppCounts, data.TorrentCounts, data.SendCounts = statusCounts(&Supp{}), statusCounts(&SuppTorrent{}), statusCounts(&SendRecord{})
	a.render(w, "layout.html", data)
}

func parseID(r *http.Request) (uint, error) {
	value, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	return uint(value), err
}

func loadSuppDetail(id uint) (*SuppDetail, error) {
	result := &SuppDetail{}
	if err := db.First(&result.Supp, id).Error; err != nil {
		return nil, err
	}
	var records []SuppTorrent
	if err := db.Where("supp_id=?", id).Order("id").Find(&records).Error; err != nil {
		return nil, err
	}
	live, liveErr := getTorrentsCached()
	if liveErr != nil {
		log.Printf("admin qBittorrent detail: %v", liveErr)
	}
	ids := make([]uint, 0, len(records))
	for _, record := range records {
		detail := TorrentDetail{Record: record}
		if torrent, ok := live[strings.ToLower(record.Hash)]; ok {
			copy := torrent
			detail.Live = &copy
		}
		result.Torrents = append(result.Torrents, detail)
		ids = append(ids, record.ID)
	}
	if len(ids) > 0 {
		if err := db.Where("torrent_id IN ?", ids).Order("id").Find(&result.Sends).Error; err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (a *adminApp) suppDetail(w http.ResponseWriter, r *http.Request) {
	data := a.baseData(w, r, "补档详情", "detail")
	id, err := parseID(r)
	if err == nil {
		data.Detail, err = loadSuppDetail(id)
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		data.Error = err.Error()
	}
	a.render(w, "layout.html", data)
}

func (a *adminApp) updateStatus(w http.ResponseWriter, r *http.Request) {
	if !validCSRF(r) {
		http.Error(w, "CSRF 校验失败", http.StatusForbidden)
		return
	}
	id, err := parseID(r)
	if err != nil {
		http.Error(w, "无效记录 ID", http.StatusBadRequest)
		return
	}
	status := r.FormValue("status")
	if status != "done" && status != "error" && status != "running" {
		http.Error(w, "无效状态", http.StatusBadRequest)
		return
	}
	var supp Supp
	if err = db.First(&supp, id).Error; errors.Is(err, gorm.ErrRecordNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if _, ok := runningSupp.GetByUrlPath(supp.ArticleUrlPath); ok {
		http.Error(w, "该补档正在内存中执行，不能修改", http.StatusConflict)
		return
	}
	if err = db.Model(&Supp{}).Where("id=?", id).Update("status", status).Error; err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	back := r.FormValue("return_to")
	if !strings.HasPrefix(back, adminBasePath+"/") {
		back = adminBasePath + "/supps/" + strconv.FormatUint(uint64(id), 10)
	}
	separator := "?"
	if strings.Contains(back, "?") {
		separator = "&"
	}
	http.Redirect(w, r, back+separator+"notice="+url.QueryEscape("状态已更新为 "+status), http.StatusSeeOther)
}

func (a *adminApp) runtimeAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(runtimeSnapshot())
}
func (a *adminApp) render(w http.ResponseWriter, name string, data adminPageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := a.templates.ExecuteTemplate(w, name, data); err != nil {
		log.Printf("admin template: %v", err)
	}
}

func humanBytes(value int) string {
	v := float64(value)
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	i := 0
	for v >= 1024 && i < len(units)-1 {
		v /= 1024
		i++
	}
	return fmt.Sprintf("%.1f %s", v, units[i])
}
func humanDuration(seconds int) string {
	if seconds < 0 || seconds >= 8640000 {
		return "-"
	}
	d := time.Duration(seconds) * time.Second
	return d.Round(time.Second).String()
}

func formatTime(value any) string {
	var result time.Time
	switch typed := value.(type) {
	case time.Time:
		result = typed
	case *time.Time:
		if typed != nil {
			result = *typed
		}
	}
	if result.IsZero() {
		return "-"
	}
	return result.Format("2006-01-02 15:04:05")
}

func articleURL(path string) string {
	host := "www.hacg.mov"
	if value, err := os.ReadFile("liuli.link"); err == nil && strings.TrimSpace(string(value)) != "" {
		host = strings.TrimSpace(string(value))
	}
	return "https://" + host + path
}

func telegramURL(chatID, messageID int64) string {
	if messageID <= 0 {
		return ""
	}
	chat := strconv.FormatInt(chatID, 10)
	chat = strings.TrimPrefix(chat, "-100")
	if chat == "" || strings.HasPrefix(chat, "-") {
		return ""
	}
	return "https://t.me/c/" + chat + "/" + strconv.FormatInt(messageID, 10)
}
