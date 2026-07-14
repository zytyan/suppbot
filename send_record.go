package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func torrentSourcePath(root, path string) string {
	info, err := os.Stat(root)
	if err == nil && !info.IsDir() {
		return filepath.Base(path)
	}
	rel, err := filepath.Rel(root, path)
	if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return filepath.ToSlash(rel)
	}
	return filepath.Base(path)
}

const (
	TorrentStatusUnknown    = "unknown"
	TorrentStatusPending    = "pending"
	TorrentStatusProcessing = "processing"
	TorrentStatusDone       = "done"
	TorrentStatusError      = "error"

	SendTypeOriginal     = "original"
	SendTypeArchive      = "archive"
	SendTypeSplitArchive = "split_archive"
	SendTypeVideo        = "video"

	SendStatusPending         = "pending"
	SendStatusSuccess         = "success"
	SendStatusFailed          = "failed"
	SendStatusSkippedTooLarge = "skipped_too_large"
)

type SuppTorrent struct {
	gorm.Model
	SuppID uint   `gorm:"uniqueIndex:idx_supp_torrent"`
	Hash   string `gorm:"size:64;uniqueIndex:idx_supp_torrent"`
	Status string `gorm:"size:32;index"`
	Error  string
}

type SendRecord struct {
	gorm.Model
	TorrentID  uint   `gorm:"uniqueIndex:idx_send_record_key"`
	SourcePath string `gorm:"uniqueIndex:idx_send_record_key"`
	SendType   string `gorm:"size:32;uniqueIndex:idx_send_record_key"`
	FileName   string `gorm:"uniqueIndex:idx_send_record_key"`
	Status     string `gorm:"size:32;index"`
	Error      string

	FileID       string
	FileUniqueID string

	ChannelChatID    int64
	ChannelMessageID int64
	GroupChatID      int64
	GroupMessageID   int64
}

func migrateSendRecords() error {
	if err := db.AutoMigrate(&Supp{}, &SuppTorrent{}, &SendRecord{}); err != nil {
		return err
	}
	var supps []Supp
	if err := db.Find(&supps).Error; err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for i := range supps {
			if err := ensureSuppTorrentsTx(tx, &supps[i], TorrentStatusUnknown); err != nil {
				return err
			}
		}
		return nil
	})
}

func ensureSuppTorrents(supp *Supp, initialStatus string) error {
	return db.Transaction(func(tx *gorm.DB) error {
		return ensureSuppTorrentsTx(tx, supp, initialStatus)
	})
}

func ensureSuppTorrentsTx(tx *gorm.DB, supp *Supp, initialStatus string) error {
	if supp.ID == 0 {
		return errors.New("cannot create torrent records for an unsaved supp")
	}
	for _, hash := range supp.Magnets {
		hash = strings.ToLower(strings.TrimSpace(hash))
		if hash == "" {
			continue
		}
		record := SuppTorrent{SuppID: supp.ID, Hash: hash, Status: initialStatus}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&record).Error; err != nil {
			return err
		}
	}
	return nil
}

func getSuppTorrent(supp *Supp, hash string) (*SuppTorrent, error) {
	hash = strings.ToLower(strings.TrimSpace(hash))
	if supp.ID == 0 {
		return &SuppTorrent{Hash: hash, Status: TorrentStatusPending}, nil
	}
	if err := ensureSuppTorrents(supp, TorrentStatusPending); err != nil {
		return nil, err
	}
	var torrent SuppTorrent
	if err := db.Where("supp_id = ? AND hash = ?", supp.ID, hash).Take(&torrent).Error; err != nil {
		return nil, err
	}
	return &torrent, nil
}

func setTorrentStatus(torrent *SuppTorrent, status string, err error) error {
	torrent.Status = status
	if err == nil {
		torrent.Error = ""
	} else {
		torrent.Error = err.Error()
	}
	if torrent.ID == 0 {
		return nil
	}
	return db.Save(torrent).Error
}

func prepareSendRecord(torrent *SuppTorrent, sourcePath, sendType, fileName string) (*SendRecord, bool, error) {
	record := SendRecord{
		TorrentID:  torrent.ID,
		SourcePath: sourcePath,
		SendType:   sendType,
		FileName:   fileName,
		Status:     SendStatusPending,
	}
	if err := db.Where("torrent_id = ? AND source_path = ? AND send_type = ? AND file_name = ?",
		torrent.ID, sourcePath, sendType, fileName).FirstOrCreate(&record).Error; err != nil {
		return nil, false, err
	}
	if record.Status == SendStatusSuccess || record.Status == SendStatusSkippedTooLarge {
		return &record, true, nil
	}
	record.Status = SendStatusPending
	record.Error = ""
	if err := db.Save(&record).Error; err != nil {
		return nil, false, err
	}
	return &record, false, nil
}

func markSendRecordFailed(record *SendRecord, err error) error {
	record.Status = SendStatusFailed
	if err != nil {
		record.Error = err.Error()
	}
	return db.Save(record).Error
}

func markSendRecordSkipped(record *SendRecord, reason string) error {
	record.Status = SendStatusSkippedTooLarge
	record.Error = reason
	return db.Save(record).Error
}
