package main

import (
	"time"

	"github.com/PaulSonOfLars/gotgbot/v2"
)

func (m *TaskManager) RecordMessage(supp *Supp, msg *gotgbot.Message, role, mediaType, text, caption, parseMode, sourcePath, groupKey string, groupIndex, groupTotal int) error {
	if m == nil || supp == nil || msg == nil {
		return nil
	}
	record := SuppMessage{
		ArticleUrlPath: supp.ArticleUrlPath,
		Role:           role,
		ChatID:         msg.Chat.Id,
		MessageID:      msg.MessageId,
		MediaType:      mediaType,
		Text:           text,
		Caption:        caption,
		ParseMode:      parseMode,
		SourcePath:     sourcePath,
		GroupKey:       groupKey,
		GroupIndex:     groupIndex,
		GroupTotal:     groupTotal,
		SentAt:         time.Now(),
	}
	fillMessageFile(&record, msg)
	return m.db.Create(&record).Error
}

func fillMessageFile(record *SuppMessage, msg *gotgbot.Message) {
	switch {
	case len(msg.Photo) > 0:
		record.MediaType = "photo"
		best := msg.Photo[0]
		for _, photo := range msg.Photo[1:] {
			if photo.FileSize > best.FileSize || photo.Width*photo.Height > best.Width*best.Height {
				best = photo
			}
		}
		record.FileID = best.FileId
		record.FileUniqueID = best.FileUniqueId
		record.FileSize = best.FileSize
	case msg.Video != nil:
		record.MediaType = "video"
		record.FileID = msg.Video.FileId
		record.FileUniqueID = msg.Video.FileUniqueId
		record.FileName = msg.Video.FileName
		record.FileSize = msg.Video.FileSize
		record.MimeType = msg.Video.MimeType
	case msg.Document != nil:
		record.MediaType = "document"
		record.FileID = msg.Document.FileId
		record.FileUniqueID = msg.Document.FileUniqueId
		record.FileName = msg.Document.FileName
		record.FileSize = msg.Document.FileSize
		record.MimeType = msg.Document.MimeType
	}
	if record.Caption == "" {
		record.Caption = msg.Caption
	}
	if record.Text == "" {
		record.Text = msg.Text
	}
}
