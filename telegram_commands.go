package main

import (
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
)

func (m *TaskManager) OnTasksCommand(b *gotgbot.Bot, ctx *ext.Context) error {
	msg := ctx.EffectiveMessage
	if config.AdminId != 0 && (msg.From == nil || msg.From.Id != config.AdminId) {
		return nil
	}
	var tasks []Supp
	if err := m.db.Order("updated_at desc").Limit(10).Find(&tasks).Error; err != nil {
		return err
	}
	text := formatTasksText(tasks)
	_, err := b.SendMessage(msg.Chat.Id, text, &gotgbot.SendMessageOpts{
		ParseMode: gotgbot.ParseModeHTML,
	})
	return err
}

func formatTasksText(tasks []Supp) string {
	if len(tasks) == 0 {
		return "暂无任务"
	}
	var b strings.Builder
	b.WriteString("最近任务：\n")
	for _, task := range tasks {
		title := task.ArticleTitle
		if title == "" {
			title = task.ArticleUrlPath
		}
		title = truncateRunes(title, 36)
		updated := task.UpdatedAt.Format("01-02 15:04")
		if task.UpdatedAt.IsZero() {
			updated = time.Now().Format("01-02 15:04")
		}
		fmt.Fprintf(&b, "#%d %s %s\n%s\n%s\n\n", task.ID, task.Status, updated, html.EscapeString(title), html.EscapeString(task.CurrentStep))
	}
	return b.String()
}

func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if limit <= 0 || len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "..."
}
