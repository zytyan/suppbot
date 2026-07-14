package main

import (
	"errors"
	"fmt"
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/zytyan/suppbot/archive_proc"
	"github.com/zytyan/suppbot/helper"
	"github.com/zytyan/suppbot/qbit"
	"github.com/zytyan/suppbot/strnum"
	"log"
	"os"
	"path/filepath"
	"time"
)

func rarFiles(file string) (p *preparedFiles, err error) {
	stem := helper.Truncate(helper.Stem(file), 55)
	dir := filepath.Join(os.TempDir(), stem)
	if _, err = os.Stat(dir); err == nil {
		os.RemoveAll(dir)
	}
	err = os.MkdirAll(dir, 0755)
	if err != nil {
		panic(err)
	}
	p = &preparedFiles{isRar: true}
	rarName := stem + ".rar"
	err = archive_proc.PackToRar(file, dir, rarName)
	if err != nil {
		return
	}
	p.cleanupFn = func() { os.RemoveAll(dir) }
	var entries []os.DirEntry
	entries, err = os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, f := range entries {
		p.files = append(p.files, filepath.Join(dir, f.Name()))
	}
	return
}

type preparedFiles struct {
	files     []string
	isRar     bool
	cleanupFn func()
}

func (p *preparedFiles) cleanup() {
	if p.cleanupFn != nil {
		p.cleanupFn()
	}
}

func prepareUploadFiles(path string) (p *preparedFiles, err error) {
	if helper.NeedRar(path) {
		return rarFiles(path)
	}
	p = &preparedFiles{isRar: false}
	stat, err := os.Stat(path)
	if err != nil {
		return
	}
	if !stat.IsDir() {
		p.files = []string{path}
		return
	}
	files, err := os.ReadDir(path)
	if err != nil {
		return
	}
	for _, file := range files {
		p.files = append(p.files, filepath.Join(path, file.Name()))
	}
	return
}

func rarText(index, total int) string {
	if total == 1 {
		return "这是一个由补档bot创建的压缩包，它并没有密码或分卷，下载后应该可以直接解压。\n" +
			"如果解压后仍有压缩文件+密码，请检查原始帖文中是否有对应的密码。"
	}
	return fmt.Sprintf("这是一个分卷压缩包文件，共%d个分卷。\n"+
		"本条消息中的压缩包为分卷%d\n"+
		"您需要下载总共所有%d个分卷才可以正确解压这批压缩包。\n"+
		"如果您使用的软件并非WinRAR，在解压本消息中的压缩包时遇到需要输入密码等意外情况，请考虑您是否下载了所有的压缩包分卷并放置于同一目录下。\n"+
		"如果您使用的是WinRAR这款软件，其应能正确提示您需要更多分卷才能完整解压。\n"+
		"由本程序创建的压缩文件不会有任何密码，如果内部还有压缩文件+密码，请检查原始帖文中是否有对应的密码。",
		total, index, total)
}

func uploadFile(supp *Supp, torrent *SuppTorrent, record *SendRecord, file, captionText string, index, total int) error {
	doc := gotgbot.InputFileByURL(fileSchema(file))
	const retryCount = 5
	var lastErr error
	for i := 0; i < retryCount; i++ {
		trackTorrentWork(supp, torrent.Hash, "上传文件", file, index, total, i+1, 1, nil)
		msg, err := bot.SendDocument(supp.LinkedGroupMsg.ChatId, doc, &gotgbot.SendDocumentOpts{
			Caption: captionText,
			ReplyParameters: &gotgbot.ReplyParameters{
				MessageId:                supp.LinkedGroupMsg.Id,
				ChatId:                   supp.LinkedGroupMsg.ChatId,
				AllowSendingWithoutReply: false,
				Quote:                    "",
				QuoteParseMode:           "",
				QuoteEntities:            nil,
				QuotePosition:            0,
			},
		})
		if err == nil {
			if msg.Document == nil {
				err = errors.New("telegram response has no document")
			} else {
				record.Status = SendStatusSuccess
				record.Error = ""
				record.FileID = msg.Document.FileId
				record.FileUniqueID = msg.Document.FileUniqueId
				record.GroupChatID = msg.Chat.Id
				record.GroupMessageID = msg.MessageId
				if saveErr := db.Save(record).Error; saveErr != nil {
					return saveErr
				}
			}
		}
		if err == nil {
			log.Printf("send message to chat %d msg id: %d\n", msg.Chat.Id, msg.MessageId)
			return nil
		}
		lastErr = err
		time.Sleep(1 * time.Minute)
	}
	err := fmt.Errorf("send message failed after %d attempts: %w", retryCount, lastErr)
	if saveErr := markSendRecordFailed(record, err); saveErr != nil {
		return errors.Join(err, saveErr)
	}
	return err
}

func UploadRawFiles(t *qbit.Torrent, supp *Supp, torrentRecord *SuppTorrent) error {
	path := t.ContentPath
	trackTorrentWork(supp, torrentRecord.Hash, "准备文件或打包", path, 0, 0, 0, 1, nil)
	files, err := prepareUploadFiles(path)
	if err != nil {
		log.Println(err)
		return err
	}
	defer files.cleanup()
	var newFiles []string
	for _, file := range files.files {
		if helper.IsVideoFile(file) {
			// skip video files
			continue
		}
		newFiles = append(newFiles, file)
	}
	newFiles = strnum.SortedStrings(newFiles)
	log.Printf("prepare to upload %d files\n", len(newFiles))
	var uploadErr error
	for idx, filename := range newFiles {
		caption := ""
		sendType := SendTypeOriginal
		sourcePath := torrentSourcePath(path, filename)
		if files.isRar {
			caption = rarText(idx+1, len(newFiles))
			sendType = SendTypeArchive
			if len(newFiles) > 1 {
				sendType = SendTypeSplitArchive
			}
			sourcePath = "archive:" + filepath.Base(filename)
		}
		record, skip, err := prepareSendRecord(torrentRecord, sourcePath, sendType, filepath.Base(filename))
		if err != nil {
			uploadErr = errors.Join(uploadErr, err)
			continue
		}
		if skip {
			log.Printf("skip previously completed file %s\n", filename)
			continue
		}
		err = uploadFile(supp, torrentRecord, record, filename, caption, idx, len(newFiles))
		if err != nil {
			log.Println(err)
			uploadErr = errors.Join(uploadErr, fmt.Errorf("upload %s: %w", filename, err))
		}
	}
	trackTorrentWork(supp, torrentRecord.Hash, "文件上传完成", "", len(newFiles), len(newFiles), 0, 1, uploadErr)
	return uploadErr
}
