package main

import (
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/PaulSonOfLars/gotgbot/v2/ext"
	"github.com/PaulSonOfLars/gotgbot/v2/ext/handlers"
	"log"
	"net/http"
	"time"
)

func main() {
	var err error
	bot, err = gotgbot.NewBot(config.BotToken, &gotgbot.BotOpts{
		BotClient: &gotgbot.BaseBotClient{
			Client:             http.Client{},
			UseTestEnvironment: false,
			DefaultRequestOpts: &gotgbot.RequestOpts{
				Timeout: 120 * time.Minute,
				APIURL:  config.BaseUrl,
			},
		},
	})
	if err != nil {
		panic(err)
	}
	if err = startAdminServer(); err != nil {
		panic(err)
	}
	go SuppLoop()
	dispatcher := ext.NewDispatcher(nil)
	updater := ext.NewUpdater(dispatcher, &ext.UpdaterOpts{
		UnhandledErrFunc: nil,
		ErrorLog:         nil,
	})
	dispatcher.AddHandler(handlers.NewMessage(IsAutoForwardedSuppMsg, OnLinkedGroupMsg))
	err = updater.StartPolling(bot, nil)
	if err != nil {
		panic(err)
	}
	log.Printf("Authorized on account %s", bot.User.Username)
	updater.Idle()
}
