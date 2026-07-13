package main

import (
	_ "github.com/mattn/go-sqlite3"
	"github.com/zytyan/suppbot/qbit"
	"os"
	"strconv"
	"strings"
)

import (
	"github.com/BurntSushi/toml"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type QbitConfig struct {
	Host string `toml:"host"`
	User string `toml:"username"`
	Pass string `toml:"password"`
}

type SuppConfig struct {
	BotToken string `toml:"bot-token"`
	BaseUrl  string `toml:"base-url"`
	Database string `toml:"database"`

	ChannelId      int64 `toml:"channel-id"`
	GroupId        int64 `toml:"group-id"`
	VideoChannelId int64 `toml:"video-channel-id"`
	AdminId        int64 `toml:"admin-id"`

	TphAccessToken string `toml:"tph-access-token"`

	Qbit QbitConfig `toml:"qbit"`
}

var qClient *qbit.Client
var db *gorm.DB

var config = func() SuppConfig {
	parseFlags()
	var conf SuppConfig
	// read conf.toml
	// if not exists, or error, print error and exit
	file := "config/config.toml"
	if globalFlags.UseTest {
		file = "config/config-test.toml"
	}
	_, err := toml.DecodeFile(file, &conf)
	if err != nil {
		panic(err)
	}
	qClient = qbit.NewClient(conf.Qbit.Host, conf.Qbit.User, conf.Qbit.Pass)
	err = qClient.Login()
	if err != nil {
		panic(err)
	}
	db, err = gorm.Open(sqlite.Open(conf.Database), &gorm.Config{})
	if err != nil {
		panic(err)
	}
	return conf
}()

type flags struct {
	UseTest   bool
	LiuliPage int
}

var globalFlags = flags{}

func parseFlags() {
	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		switch {
		case arg == "-test":
			globalFlags.UseTest = true
		case arg == "-page" && i+1 < len(os.Args):
			i++
			globalFlags.LiuliPage, _ = strconv.Atoi(os.Args[i])
		case strings.HasPrefix(arg, "-page="):
			globalFlags.LiuliPage, _ = strconv.Atoi(strings.TrimPrefix(arg, "-page="))
		}
	}
}
