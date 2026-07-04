package main

import (
	"fmt"
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"html"
	"log"
	"main/crawler"
	"net/url"
	"path/filepath"
	"time"
)

var bot *gotgbot.Bot

func init() {
	err := db.AutoMigrate(&Supp{}, &LinkedGroupEvent{}, &SuppMessage{})
	if err != nil {
		panic(err)
	}
}

func fileSchema(filename string) string {
	if !filepath.IsAbs(filename) {
		var err error
		filename, err = filepath.Abs(filename)
		if err != nil {
			log.Println(err)
			return ""
		}
	}
	return "file://" + url.PathEscape(filename)
}

func prepareMsgText(article *crawler.Article) string {
	return fmt.Sprintf("<a href=\"%s\">%s</a>\n"+
		"由 %s 发表于 %s\n"+
		"分类：%s\n"+
		"标签：%s\n"+
		"%s",
		html.EscapeString(article.Url),
		html.EscapeString(article.Title),
		html.EscapeString(article.Author),
		html.EscapeString(article.PostTime),
		html.EscapeString(article.Category),
		html.EscapeString(article.HashTags()),
		html.EscapeString(article.IdTag()))
}

func createSuppFromArticle(article *crawler.Article) (*Supp, error) {
	urlPath := article.UrlPath()
	if urlPath == "" {
		return nil, fmt.Errorf("article url path is empty, url is %s", article.Url)
	}
	magnets, err := crawler.GetMagnetsFromLink(article.Url)
	if err != nil {
		return nil, err
	}
	return &Supp{
		ArticleUrlPath: urlPath,
		ArticleTitle:   article.Title,
		ArticleUrl:     article.Url,
		Magnets:        magnets,
		TotalMagnets:   len(magnets),
		Status:         string(TaskDiscovered),
		CurrentStep:    "已发现文章，等待发送频道消息",
	}, nil
}

func suppLoopInner(manager *TaskManager) {
	articles, err := crawler.GetArticles(globalFlags.LiuliPage)
	if err != nil {
		log.Println(err)
		return
	}
	for _, article := range articles {
		err = manager.EnqueueArticle(&article)
		if err != nil {
			log.Println(err)
		}
	}
}
func SuppLoop(manager *TaskManager) {
	for {
		suppLoopInner(manager)
		time.Sleep(2 * time.Hour)
	}
}

func IsAutoForwardedSuppMsg(msg *gotgbot.Message) bool {
	if !msg.IsAutomaticForward || msg.ForwardOrigin == nil {
		return false
	}
	ori := msg.ForwardOrigin.MergeMessageOrigin()
	if ori.Chat == nil {
		return false
	}
	if ori.Chat.Id != config.ChannelId {
		return false
	}
	return ori.MessageId != 0
}

func (m *TaskManager) OnLinkedGroupMsg(_ *gotgbot.Bot, ctx *ext.Context) error {
	msg := ctx.EffectiveMessage
	origin := msg.ForwardOrigin.MergeMessageOrigin()
	cid := origin.Chat.Id
	mid := origin.MessageId
	log.Printf("get linked group msg, channel id: %d, channel msg id: %d, group id: %d, group msg id: %d", cid, mid, msg.Chat.Id, msg.MessageId)
	return m.HandleLinkedGroupEvent(cid, mid, msg.Chat.Id, msg.MessageId)
}
