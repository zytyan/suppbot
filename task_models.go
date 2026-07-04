package main

import (
	"database/sql/driver"
	"fmt"
	"reflect"
	"strings"
	"time"

	"gorm.io/gorm"
)

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
	ArticleUrlPath string `gorm:"uniqueIndex"`
	ArticleTitle   string
	ArticleUrl     string
	ChannelMsg     Msg `gorm:"embedded;embeddedPrefix:channel_"`
	LinkedGroupMsg Msg `gorm:"embedded;embeddedPrefix:linked_group_"`
	Magnets        TypeMagnets
	Status         string
	CurrentStep    string
	ErrorMessage   string

	TotalMagnets int
	DoneMagnets  int
	CurrentHash  string

	TotalVideos    int
	UploadedVideos int
	TotalRawFiles  int
	UploadedRaw    int

	StartedAt  *time.Time
	FinishedAt *time.Time
}

type TaskStatus string

const (
	TaskDiscovered       TaskStatus = "discovered"
	TaskSendingChannel   TaskStatus = "sending_channel_msg"
	TaskWaitingLinkedMsg TaskStatus = "waiting_linked_msg"
	TaskReady            TaskStatus = "ready"
	TaskDownloading      TaskStatus = "downloading"
	TaskUploadingVideo   TaskStatus = "uploading_video"
	TaskUploadingRaw     TaskStatus = "uploading_raw"
	TaskDone             TaskStatus = "done"
	TaskError            TaskStatus = "error"
	TaskCancelled        TaskStatus = "cancelled"
)

func terminalTaskStatus(status string) bool {
	switch TaskStatus(status) {
	case TaskDone, TaskError, TaskCancelled:
		return true
	default:
		return false
	}
}

type LinkedGroupEvent struct {
	gorm.Model
	ChannelChatID int64 `gorm:"uniqueIndex:idx_origin"`
	ChannelMsgID  int64 `gorm:"uniqueIndex:idx_origin"`
	GroupChatID   int64
	GroupMsgID    int64
}

type SuppMessage struct {
	gorm.Model
	ArticleUrlPath string `gorm:"index"`

	Role      string
	ChatID    int64
	MessageID int64

	MediaType string
	Text      string
	Caption   string
	ParseMode string

	FileID       string
	FileUniqueID string
	FileName     string
	FileSize     int64
	MimeType     string

	SourcePath string

	GroupKey   string
	GroupIndex int
	GroupTotal int

	SentAt time.Time
}
