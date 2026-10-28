package main

import (
	"strings"

	"github.com/PaulSonOfLars/gotgbot/v2"
	"gorm.io/gorm"
)

// ChatIdentity maps a Telegram chat ID to its public identity.
type ChatIdentity struct {
	gorm.Model
	ChatID   int64  `gorm:"uniqueIndex;not null"`
	Username string `gorm:"size:255;index"`
	Title    string `gorm:"size:255"`
	Type     string `gorm:"size:32"`
}

var knownChatIdentities = []ChatIdentity{
	{ChatID: -1001385438626, Username: "liuli_link", Title: "琉璃神社 补档", Type: "channel"},
	{ChatID: -1001126205241, Username: "liuli_link_group", Title: "补档文件", Type: "supergroup"},
}

func seedKnownChatIdentities() {
	for _, identity := range knownChatIdentities {
		db.Where("chat_id = ?", identity.ChatID).Assign(identity).FirstOrCreate(&identity)
	}
}

func saveChatIdentity(chat *gotgbot.Chat) {
	if chat == nil || chat.Id == 0 {
		return
	}
	identity := ChatIdentity{ChatID: chat.Id, Username: strings.TrimPrefix(strings.TrimSpace(chat.Username), "@"), Title: chat.Title, Type: chat.Type}
	db.Where("chat_id = ?", chat.Id).Assign(identity).FirstOrCreate(&identity)
}
