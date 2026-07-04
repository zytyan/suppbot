package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"gorm.io/gorm"
	"html"
	"log"
	"main/crawler"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
)

var bot *gotgbot.Bot

type Msg struct {
	ChatId int64
	Id     int64
}

// TypeMagnets is a custom type for gorm to store magnet links
// in database.
// form: hash1,hash2,hash3,...
type TypeMagnets []string

func (m *TypeMagnets) Scan(value any) error {
	if value == nil {
		*m = nil
		return nil
	}
	str, ok := value.(string)
	if !ok {
		return fmt.Errorf("failed to scan value type(%s):%s to TypeMagnets", reflect.TypeOf(value), value)
	}
	*m = strings.Split(str, ",")
	return nil
}

func (m TypeMagnets) Value() (driver.Value, error) {
	return strings.Join(m, ","), nil
}

type Supp struct {
	gorm.Model
	ArticleUrlPath string `gorm:"primaryKey"`
	ChannelMsg     Msg    `gorm:"embedded;embeddedPrefix:channel_"`
	LinkedGroupMsg Msg    `gorm:"embedded;embeddedPrefix:linked_group_"`
	Magnets        TypeMagnets
	Status         string
	barrier        sync.WaitGroup
}

func init() {
	err := db.AutoMigrate(&Supp{})
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

func startSupp(supp *Supp) {
	err := DownloadMagnet(supp.Magnets)
	if err != nil {
		log.Println(err)
		return
	}
	supp.barrier.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Hour)
	defer cancel()
	errChan := make(chan error, len(supp.Magnets))
	var wg sync.WaitGroup
	for idx, hash := range supp.Magnets {
		log.Printf("start proc magnet[%d] %s\n", idx, hash)
		wg.Go(func() {
			err := WaitAndProcMagnet(ctx, supp, hash)
			if err != nil {
				errChan <- err
				log.Println(err)
			}
		})
	}
	wg.Wait()
	close(errChan)
	var errGroup error
	for err := range errChan {
		errGroup = errors.Join(errGroup, err)
	}
	if errGroup != nil {
		supp.Status = "error"
	} else {
		supp.Status = "done"
	}
	runningSupp.Remove(supp)
	log.Printf("supp %s done, current running %d\n", supp.ArticleUrlPath, runningSupp.Size())
	db.Save(supp)
}

var mu sync.Mutex

func sendSuppMsg(article *crawler.Article, supp *Supp) error {
	text := prepareMsgText(article)
	imgFile, err := article.DownloadImgToFile()
	if err != nil {
		imgFile, err = noImageFile()
		if err != nil {
			return err
		}
	} else {
		defer os.Remove(imgFile)
	}
	imgFile = fileSchema(imgFile)
	photo := gotgbot.InputFileByURL(imgFile)
	mu.Lock()
	defer mu.Unlock()
	// 一定要把发送消息的流程也用锁保护起来，否则有可能出问题
	msg, err := bot.SendPhoto(config.ChannelId, photo, &gotgbot.SendPhotoOpts{
		Caption:   text,
		ParseMode: "HTML",
	})
	if err != nil {
		log.Println(err)
		return err
	}
	key := Msg{ChatId: msg.Chat.Id, Id: msg.MessageId}
	supp.ChannelMsg = key
	supp.Status = "running"
	supp.barrier.Add(1)
	runningSupp.Add(supp)
	return nil
}

func ProcArticle(article *crawler.Article) error {
	if runningSupp.Size() >= 2 {
		log.Println("too many running supp, skip")
		return nil
	}
	urlPath := article.UrlPath()
	if urlPath == "" {
		return fmt.Errorf("article url path is empty, url is %s", article.Url)
	}
	if _, ok := runningSupp.GetByUrlPath(article.UrlPath()); ok {
		log.Printf("article %s already running, skip\n", article.Url)
		return nil
	}
	supp := &Supp{ArticleUrlPath: urlPath}
	err := db.Take(supp).Error
	if err == nil {
		switch supp.Status {
		case "running":
			log.Printf("supp %s is running, current status %s, chnnel id: %d, channel msg id: %d, group id: %d, group msg id: %d\n",
				article.Title, supp.Status, supp.ChannelMsg.ChatId, supp.ChannelMsg.Id, supp.LinkedGroupMsg.ChatId, supp.LinkedGroupMsg.Id)
		case "error":
			log.Printf("supp %s error, current status %s, chnnel id: %d, channel msg id: %d, group id: %d, group msg id: %d\n",
				article.Title, supp.Status, supp.ChannelMsg.ChatId, supp.ChannelMsg.Id, supp.LinkedGroupMsg.ChatId, supp.LinkedGroupMsg.Id)
			return nil
		case "done":
			log.Printf("supp %s already done, skip\n", article.Title)
			return nil
		}
	} else {
		magnets, err := crawler.GetMagnetsFromLink(article.Url)
		if err != nil {
			return err
		}
		supp.Magnets = magnets
	}
	log.Printf("start proc article %s, now time: %s, current running %d\n", article.Title, time.Now().Format("2006-01-02 15:04:05"), runningSupp.Size())
	if supp.ChannelMsg.Id == 0 || supp.LinkedGroupMsg.Id == 0 {
		err = sendSuppMsg(article, supp)
	} else {
		runningSupp.Add(supp)
	}
	go startSupp(supp)
	return err
}

func suppLoopInner() {
	articles, err := crawler.GetArticles(globalFlags.LiuliPage)
	if err != nil {
		log.Println(err)
		return
	}
	for _, article := range articles {
		err = ProcArticle(&article)
		if err != nil {
			log.Println(err)
		}
	}
}
func SuppLoop() {
	for {
		suppLoopInner()
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

func OnLinkedGroupMsg(_ *gotgbot.Bot, ctx *ext.Context) error {
	mu.Lock()
	defer mu.Unlock()
	msg := ctx.EffectiveMessage
	origin := msg.ForwardOrigin.MergeMessageOrigin()
	cid := origin.Chat.Id
	mid := origin.MessageId
	key := Msg{ChatId: cid, Id: mid}
	supp, ok := runningSupp.GetByMsg(key)
	log.Printf("get linked group msg, channel id: %d, channel msg id: %d, group id: %d, group msg id: %d", cid, mid, msg.Chat.Id, msg.MessageId)
	if !ok {
		return fmt.Errorf("no supp found for linked group msg, channel id: %d, channel msg id: %d, group id: %d, group msg id: %d", cid, mid, msg.Chat.Id, msg.MessageId)
	}
	supp.LinkedGroupMsg = Msg{ChatId: msg.Chat.Id, Id: msg.MessageId}
	db.Save(supp)
	supp.barrier.Done()
	return nil
}
