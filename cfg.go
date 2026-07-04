package main

import (
	"flag"
	"main/qbit"
	"os"

	"github.com/BurntSushi/toml"
	_ "github.com/mattn/go-sqlite3"
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
	WebAddr        string `toml:"web-addr"`

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
	if conf.WebAddr == "" {
		conf.WebAddr = "127.0.0.1:8989"
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
	parser := flag.NewFlagSet("supp", flag.ExitOnError)
	parser.BoolVar(&globalFlags.UseTest, "test", false, "use test config")
	parser.IntVar(&globalFlags.LiuliPage, "page", 0, "liuli page")
	err := parser.Parse(os.Args[1:])
	if err != nil {
		panic(err)
	}
}
