package main

import (
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strconv"
	"strings"
)

func StartWebServer(addr string) {
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleWebTasks)
	mux.HandleFunc("/tasks", handleWebTasks)
	mux.HandleFunc("/tasks/", handleWebTaskDetail)
	log.Printf("task web listening on http://%s\n", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Println(err)
	}
}

func handleWebTasks(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/tasks" {
		http.NotFound(w, r)
		return
	}
	var tasks []Supp
	if err := db.Order("updated_at desc").Limit(100).Find(&tasks).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := taskListTemplate.Execute(w, tasks); err != nil {
		log.Println(err)
	}
}

func handleWebTaskDetail(w http.ResponseWriter, r *http.Request) {
	idText := strings.TrimPrefix(r.URL.Path, "/tasks/")
	id, err := strconv.ParseUint(idText, 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var task Supp
	if err = db.First(&task, id).Error; err != nil {
		http.NotFound(w, r)
		return
	}
	var messages []SuppMessage
	if err = db.Where("article_url_path = ?", task.ArticleUrlPath).Order("created_at asc").Find(&messages).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	data := struct {
		Task     Supp
		Messages []SuppMessage
	}{Task: task, Messages: messages}
	if err = taskDetailTemplate.Execute(w, data); err != nil {
		log.Println(err)
	}
}

var taskListTemplate = template.Must(template.New("tasks").Funcs(template.FuncMap{
	"short": shortText,
}).Parse(pageCSS + `
<html>
<head>
	<title>suppbot tasks</title>
	<meta http-equiv="refresh" content="5">
</head>
<body>
	<h1>suppbot tasks</h1>
	<table>
		<thead>
			<tr>
				<th>ID</th>
				<th>Status</th>
				<th>Title</th>
				<th>Step</th>
				<th>Magnets</th>
				<th>Videos</th>
				<th>Raw</th>
				<th>Updated</th>
			</tr>
		</thead>
		<tbody>
			{{range .}}
			<tr>
				<td><a href="/tasks/{{.ID}}">#{{.ID}}</a></td>
				<td><span class="status">{{.Status}}</span></td>
				<td>{{short .ArticleTitle 48}}</td>
				<td>{{short .CurrentStep 64}}</td>
				<td>{{.DoneMagnets}}/{{.TotalMagnets}}</td>
				<td>{{.UploadedVideos}}/{{.TotalVideos}}</td>
				<td>{{.UploadedRaw}}/{{.TotalRawFiles}}</td>
				<td>{{.UpdatedAt.Format "2006-01-02 15:04:05"}}</td>
			</tr>
			{{end}}
		</tbody>
	</table>
</body>
</html>
`))

var taskDetailTemplate = template.Must(template.New("task").Funcs(template.FuncMap{
	"short": shortText,
}).Parse(pageCSS + `
<html>
<head>
	<title>suppbot task {{.Task.ID}}</title>
	<meta http-equiv="refresh" content="5">
</head>
<body>
	<p><a href="/tasks">Back to tasks</a></p>
	<h1>task #{{.Task.ID}}</h1>
	<table>
		<tr><th>Status</th><td>{{.Task.Status}}</td></tr>
		<tr><th>Step</th><td>{{.Task.CurrentStep}}</td></tr>
		<tr><th>Title</th><td>{{.Task.ArticleTitle}}</td></tr>
		<tr><th>Article</th><td><a href="{{.Task.ArticleUrl}}">{{.Task.ArticleUrl}}</a></td></tr>
		<tr><th>Channel Msg</th><td>{{.Task.ChannelMsg.ChatId}} / {{.Task.ChannelMsg.Id}}</td></tr>
		<tr><th>Linked Group Msg</th><td>{{.Task.LinkedGroupMsg.ChatId}} / {{.Task.LinkedGroupMsg.Id}}</td></tr>
		<tr><th>Current Hash</th><td>{{.Task.CurrentHash}}</td></tr>
		<tr><th>Magnets</th><td>{{.Task.DoneMagnets}} / {{.Task.TotalMagnets}}</td></tr>
		<tr><th>Videos</th><td>{{.Task.UploadedVideos}} / {{.Task.TotalVideos}}</td></tr>
		<tr><th>Raw Files</th><td>{{.Task.UploadedRaw}} / {{.Task.TotalRawFiles}}</td></tr>
		<tr><th>Error</th><td class="error">{{.Task.ErrorMessage}}</td></tr>
		<tr><th>Created</th><td>{{.Task.CreatedAt.Format "2006-01-02 15:04:05"}}</td></tr>
		<tr><th>Updated</th><td>{{.Task.UpdatedAt.Format "2006-01-02 15:04:05"}}</td></tr>
	</table>
	<h2>sent messages</h2>
	<table>
		<thead>
			<tr>
				<th>Role</th>
				<th>Chat/Msg</th>
				<th>Type</th>
				<th>File ID</th>
				<th>Caption/Text</th>
				<th>Source</th>
				<th>Sent</th>
			</tr>
		</thead>
		<tbody>
			{{range .Messages}}
			<tr>
				<td>{{.Role}}</td>
				<td>{{.ChatID}} / {{.MessageID}}</td>
				<td>{{.MediaType}}</td>
				<td class="mono">{{short .FileID 28}}</td>
				<td>{{short (printf "%s%s" .Caption .Text) 80}}</td>
				<td>{{short .SourcePath 42}}</td>
				<td>{{.SentAt.Format "2006-01-02 15:04:05"}}</td>
			</tr>
			{{end}}
		</tbody>
	</table>
</body>
</html>
`))

const pageCSS = `
<style>
body {
	font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	margin: 24px;
	color: #202124;
	background: #f8f9fa;
}
h1, h2 { margin: 0 0 16px; }
table {
	border-collapse: collapse;
	width: 100%;
	background: #fff;
	border: 1px solid #dadce0;
}
th, td {
	border-bottom: 1px solid #e8eaed;
	padding: 8px 10px;
	text-align: left;
	vertical-align: top;
	font-size: 14px;
}
th { background: #f1f3f4; font-weight: 600; }
a { color: #0b57d0; text-decoration: none; }
.status, .mono {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.error { color: #b3261e; }
</style>
`

func shortText(v any, limit int) string {
	text := fmt.Sprint(v)
	runes := []rune(text)
	if limit <= 0 || len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "..."
}
