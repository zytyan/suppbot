package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/PaulSonOfLars/gotgbot/v2"
	"gorm.io/gorm"
	"main/crawler"
)

type taskRuntime struct {
	cancel context.CancelFunc
}

type TaskManager struct {
	db    *gorm.DB
	bot   *gotgbot.Bot
	limit int

	mu         sync.Mutex
	sendMu     sync.Mutex
	running    map[string]*taskRuntime
	wakeUpChan chan struct{}
}

func NewTaskManager(db *gorm.DB, bot *gotgbot.Bot, limit int) *TaskManager {
	return &TaskManager{
		db:         db,
		bot:        bot,
		limit:      limit,
		running:    make(map[string]*taskRuntime),
		wakeUpChan: make(chan struct{}, 1),
	}
}

func (m *TaskManager) Notify() {
	select {
	case m.wakeUpChan <- struct{}{}:
	default:
	}
}

func (m *TaskManager) Run(ctx context.Context) {
	m.Notify()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			m.cancelAll()
			return
		case <-m.wakeUpChan:
			m.startRunnableTasks(ctx)
		case <-ticker.C:
			m.startRunnableTasks(ctx)
		}
	}
}

func (m *TaskManager) cancelAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, rt := range m.running {
		rt.cancel()
	}
}

func (m *TaskManager) EnqueueArticle(article *crawler.Article) error {
	urlPath := article.UrlPath()
	if urlPath == "" {
		return fmt.Errorf("article url path is empty, url is %s", article.Url)
	}
	var supp Supp
	err := m.db.Where("article_url_path = ?", urlPath).Take(&supp).Error
	if err == nil {
		if terminalTaskStatus(supp.Status) {
			log.Printf("supp %s already terminal status %s, skip\n", article.Title, supp.Status)
			return nil
		}
		if supp.ChannelMsg.Id == 0 {
			return m.sendChannelMessage(article, &supp)
		}
		if supp.LinkedGroupMsg.Id == 0 {
			if err := m.bindExistingLinkedEvent(&supp); err != nil {
				return err
			}
		}
		m.Notify()
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	newSupp, err := createSuppFromArticle(article)
	if err != nil {
		return err
	}
	if err = m.db.Create(newSupp).Error; err != nil {
		return err
	}
	log.Printf("created supp task for article %s at %s\n", article.Title, time.Now().Format("2006-01-02 15:04:05"))
	return m.sendChannelMessage(article, newSupp)
}

func (m *TaskManager) sendChannelMessage(article *crawler.Article, supp *Supp) error {
	supp.Status = string(TaskSendingChannel)
	supp.CurrentStep = "正在发送频道消息"
	if err := m.db.Save(supp).Error; err != nil {
		return err
	}
	text := prepareMsgText(article)
	imgFile, err := article.DownloadImgToFile()
	removeImg := false
	if err != nil {
		imgFile, err = noImageFile()
		if err != nil {
			return err
		}
	} else {
		removeImg = true
	}
	if removeImg {
		defer os.Remove(imgFile)
	}
	photo := gotgbot.InputFileByURL(fileSchema(imgFile))
	m.sendMu.Lock()
	msg, err := m.bot.SendPhoto(config.ChannelId, photo, &gotgbot.SendPhotoOpts{
		Caption:   text,
		ParseMode: "HTML",
	})
	m.sendMu.Unlock()
	if err != nil {
		m.markError(supp, fmt.Errorf("send channel message: %w", err))
		return err
	}
	supp.ChannelMsg = Msg{ChatId: msg.Chat.Id, Id: msg.MessageId}
	supp.Status = string(TaskWaitingLinkedMsg)
	supp.CurrentStep = "已发送频道消息，等待关联群自动转发"
	if err = m.db.Save(supp).Error; err != nil {
		return err
	}
	if err = m.RecordMessage(supp, msg, "article_cover", "photo", "", text, "HTML", imgFile, "", 0, 1); err != nil {
		log.Println(err)
	}
	if err = m.bindExistingLinkedEvent(supp); err != nil {
		return err
	}
	m.Notify()
	return nil
}

func (m *TaskManager) bindExistingLinkedEvent(supp *Supp) error {
	if supp.ChannelMsg.Id == 0 || supp.ChannelMsg.ChatId == 0 {
		return nil
	}
	var event LinkedGroupEvent
	err := m.db.Where("channel_chat_id = ? AND channel_msg_id = ?", supp.ChannelMsg.ChatId, supp.ChannelMsg.Id).Take(&event).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	supp.LinkedGroupMsg = Msg{ChatId: event.GroupChatID, Id: event.GroupMsgID}
	if !terminalTaskStatus(supp.Status) {
		supp.Status = string(TaskReady)
		supp.CurrentStep = "关联群消息已匹配，等待任务执行"
	}
	return m.db.Save(supp).Error
}

func (m *TaskManager) HandleLinkedGroupEvent(channelChatID, channelMsgID, groupChatID, groupMsgID int64) error {
	event := LinkedGroupEvent{
		ChannelChatID: channelChatID,
		ChannelMsgID:  channelMsgID,
		GroupChatID:   groupChatID,
		GroupMsgID:    groupMsgID,
	}
	var existing LinkedGroupEvent
	err := m.db.Where("channel_chat_id = ? AND channel_msg_id = ?", channelChatID, channelMsgID).Take(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if err = m.db.Create(&event).Error; err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else {
		existing.GroupChatID = groupChatID
		existing.GroupMsgID = groupMsgID
		if err = m.db.Save(&existing).Error; err != nil {
			return err
		}
	}

	var supp Supp
	err = m.db.Where("channel_chat_id = ? AND channel_id = ?", channelChatID, channelMsgID).Take(&supp).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	supp.LinkedGroupMsg = Msg{ChatId: groupChatID, Id: groupMsgID}
	if !terminalTaskStatus(supp.Status) {
		supp.Status = string(TaskReady)
		supp.CurrentStep = "关联群消息已匹配，等待任务执行"
	}
	if err = m.db.Save(&supp).Error; err != nil {
		return err
	}
	m.Notify()
	return nil
}

func (m *TaskManager) startRunnableTasks(parent context.Context) {
	m.markReadyWaitingTasks()
	m.mu.Lock()
	available := m.limit - len(m.running)
	m.mu.Unlock()
	if available <= 0 {
		return
	}
	var tasks []Supp
	err := m.db.Where("status IN ?", []string{
		string(TaskReady),
		string(TaskDownloading),
		string(TaskUploadingVideo),
		string(TaskUploadingRaw),
	}).Order("updated_at asc").Limit(m.limit * 4).Find(&tasks).Error
	if err != nil {
		log.Println(err)
		return
	}
	for i := range tasks {
		if !m.startTask(parent, &tasks[i]) {
			return
		}
	}
}

func (m *TaskManager) markReadyWaitingTasks() {
	var tasks []Supp
	if err := m.db.Where("status IN ? AND linked_group_id <> 0", []string{string(TaskWaitingLinkedMsg), "running"}).Find(&tasks).Error; err != nil {
		log.Println(err)
		return
	}
	for i := range tasks {
		tasks[i].Status = string(TaskReady)
		tasks[i].CurrentStep = "关联群消息已匹配，等待任务执行"
		if err := m.db.Save(&tasks[i]).Error; err != nil {
			log.Println(err)
		}
	}
}

func (m *TaskManager) startTask(parent context.Context, supp *Supp) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.running[supp.ArticleUrlPath]; ok {
		return true
	}
	if len(m.running) >= m.limit {
		return false
	}
	ctx, cancel := context.WithCancel(parent)
	m.running[supp.ArticleUrlPath] = &taskRuntime{cancel: cancel}
	go m.runTask(ctx, supp.ArticleUrlPath)
	return true
}

func (m *TaskManager) finishRuntime(articleURLPath string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.running, articleURLPath)
}

func (m *TaskManager) runTask(ctx context.Context, articleURLPath string) {
	defer m.finishRuntime(articleURLPath)
	var supp Supp
	if err := m.db.Where("article_url_path = ?", articleURLPath).Take(&supp).Error; err != nil {
		log.Println(err)
		return
	}
	now := time.Now()
	if supp.StartedAt == nil {
		supp.StartedAt = &now
	}
	supp.Status = string(TaskDownloading)
	supp.CurrentStep = "正在提交磁链到 qBittorrent"
	supp.DoneMagnets = 0
	supp.TotalVideos = 0
	supp.UploadedVideos = 0
	supp.TotalRawFiles = 0
	supp.UploadedRaw = 0
	if err := m.db.Save(&supp).Error; err != nil {
		log.Println(err)
		return
	}
	if err := DownloadMagnet(supp.Magnets); err != nil {
		m.markError(&supp, err)
		return
	}

	errChan := make(chan error, len(supp.Magnets))
	var wg sync.WaitGroup
	for idx, hash := range supp.Magnets {
		idx, hash := idx, hash
		wg.Go(func() {
			m.UpdateTaskProgress(&supp, string(TaskDownloading), fmt.Sprintf("等待磁链下载完成 %d/%d", idx+1, len(supp.Magnets)), hash)
			if err := WaitAndProcMagnet(ctx, m, &supp, hash); err != nil {
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
		m.markError(&supp, errGroup)
		return
	}
	finishedAt := time.Now()
	supp.Status = string(TaskDone)
	supp.CurrentStep = "任务完成"
	supp.ErrorMessage = ""
	supp.FinishedAt = &finishedAt
	if err := m.db.Save(&supp).Error; err != nil {
		log.Println(err)
	}
	log.Printf("supp %s done\n", supp.ArticleUrlPath)
}

func (m *TaskManager) UpdateTaskProgress(supp *Supp, status, step, currentHash string) {
	if supp == nil {
		return
	}
	updates := map[string]any{
		"status":        status,
		"current_step":  step,
		"current_hash":  currentHash,
		"error_message": "",
	}
	if err := m.db.Model(&Supp{}).Where("article_url_path = ?", supp.ArticleUrlPath).Updates(updates).Error; err != nil {
		log.Println(err)
	}
}

func (m *TaskManager) IncrementDoneMagnet(supp *Supp) {
	if supp == nil {
		return
	}
	if err := m.db.Model(&Supp{}).Where("article_url_path = ?", supp.ArticleUrlPath).
		UpdateColumn("done_magnets", gorm.Expr("done_magnets + ?", 1)).Error; err != nil {
		log.Println(err)
	}
}

func (m *TaskManager) AddMediaTotals(supp *Supp, videos, rawFiles int) {
	updates := map[string]any{}
	if videos >= 0 {
		updates["total_videos"] = gorm.Expr("total_videos + ?", videos)
	}
	if rawFiles >= 0 {
		updates["total_raw_files"] = gorm.Expr("total_raw_files + ?", rawFiles)
	}
	if len(updates) == 0 {
		return
	}
	if err := m.db.Model(&Supp{}).Where("article_url_path = ?", supp.ArticleUrlPath).Updates(updates).Error; err != nil {
		log.Println(err)
	}
}

func (m *TaskManager) IncrementUploadedVideo(supp *Supp) {
	if err := m.db.Model(&Supp{}).Where("article_url_path = ?", supp.ArticleUrlPath).
		UpdateColumn("uploaded_videos", gorm.Expr("uploaded_videos + ?", 1)).Error; err != nil {
		log.Println(err)
	}
}

func (m *TaskManager) IncrementUploadedRaw(supp *Supp) {
	if err := m.db.Model(&Supp{}).Where("article_url_path = ?", supp.ArticleUrlPath).
		UpdateColumn("uploaded_raw", gorm.Expr("uploaded_raw + ?", 1)).Error; err != nil {
		log.Println(err)
	}
}

func (m *TaskManager) markError(supp *Supp, err error) {
	log.Println(err)
	now := time.Now()
	updates := map[string]any{
		"status":        string(TaskError),
		"current_step":  "任务失败",
		"error_message": err.Error(),
		"finished_at":   &now,
	}
	if supp != nil && supp.ArticleUrlPath != "" {
		if dbErr := m.db.Model(&Supp{}).Where("article_url_path = ?", supp.ArticleUrlPath).Updates(updates).Error; dbErr != nil {
			log.Println(dbErr)
		}
	}
}
