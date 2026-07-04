package main

import (
	"context"
	"fmt"
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/disintegration/imaging"
	"gopkg.in/vansante/go-ffprobe.v2"
	"html"
	"log"
	"main/helper"
	"main/qbit"
	"main/strnum"
	"main/videoproc"
	"os"
	"path/filepath"
	"time"
)

func toThumbnail(imgFile string) (string, error) {
	img, err := imaging.Open(imgFile)
	if err != nil {
		return "", err
	}
	// max 320x320
	width, height := img.Bounds().Dx(), img.Bounds().Dy()
	if width > 320 || height > 320 {
		if width > height {
			img = imaging.Resize(img, 320, 0, imaging.Lanczos)
		} else {
			img = imaging.Resize(img, 0, 320, imaging.Lanczos)
		}
	}
	thumbFile := imgFile + ".thumb.jpg"
	err = imaging.Save(img, thumbFile)
	if err != nil {
		return "", err
	}
	return thumbFile, nil
}

func tgThumbnail(imgFile string) (string, error) {
	thumbFile, err := toThumbnail(imgFile)
	if err != nil {
		return "", err
	}
	return fileSchema(thumbFile), nil
}

func getVideoTechSpecs(probe *ffprobe.ProbeData) string {
	v := probe.FirstVideoStream()
	if v == nil {
		return "无法获取视频信息"
	}
	var audio string
	a := probe.FirstAudioStream()

	if a != nil {
		audio = fmt.Sprintf("音频编码: %s", a.CodecName)
	} else {
		audio = "无音频"
	}
	return fmt.Sprintf("视频编码: %s\n分辨率: %dx%d\n帧率: %s\n%s", v.CodecName, v.Width, v.Height, v.AvgFrameRate, audio)
}

func uploadOneVideo(video string, supp *Supp) error {
	log.Printf("send video to: %d, %s\n", config.VideoChannelId, video)
	thumbnail, err := videoproc.MakeScreenShotTileFile(video, 3, 3)
	var thumbnailFile *gotgbot.FileReader
	if err != nil {
		thumbnail = ""
		log.Println(err)
	} else {
		defer os.Remove(thumbnail)
		t, err := tgThumbnail(thumbnail)
		if err == nil {
			thumbnailFile = gotgbot.InputFileByURL(t).(*gotgbot.FileReader)
		}
	}
	probe, err := ffprobe.ProbeURL(context.Background(), video)
	if err != nil {
		log.Printf("ffprobe %s failed: %s\n", video, err)
		return err
	}
	v := probe.FirstVideoStream()
	coverFile := gotgbot.InputFileByURL(fileSchema(thumbnail))
	log.Printf("send video %s to: %d\n", video, config.VideoChannelId)
	groupMsg, err := bot.SendPhoto(supp.LinkedGroupMsg.ChatId, coverFile, &gotgbot.SendPhotoOpts{
		Caption:    fmt.Sprintf("视频正在上传中 (%s)", time.Now().Format("2006-01-02 15:04:05")),
		HasSpoiler: true,
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
	if err != nil {
		log.Printf("send video %s cover failed: %s\n", video, err)
	}
	var groupId, groupMsgId int64
	if groupMsg != nil {
		groupId, groupMsgId = groupMsg.Chat.Id, groupMsg.MessageId
	}
	videoMsg, err := bot.SendVideo(config.VideoChannelId, gotgbot.InputFileByURL(fileSchema(video)), &gotgbot.SendVideoOpts{
		Caption:           filepath.Base(video) + "\n" + getVideoTechSpecs(probe),
		ParseMode:         "",
		Thumbnail:         thumbnailFile,
		HasSpoiler:        true,
		Width:             int64(v.Width),
		Height:            int64(v.Height),
		Duration:          int64(probe.Format.DurationSeconds),
		SupportsStreaming: true,
		ReplyParameters: &gotgbot.ReplyParameters{
			MessageId:                groupMsgId,
			ChatId:                   groupId,
			AllowSendingWithoutReply: false,
			Quote:                    "",
			QuoteParseMode:           "",
			QuoteEntities:            nil,
			QuotePosition:            0,
		},
	})
	if err != nil {
		var err2 error
		if groupMsg != nil {
			_, _, err2 = groupMsg.EditCaption(bot, &gotgbot.EditMessageCaptionOpts{
				Caption:   "视频上传失败",
				ParseMode: gotgbot.ParseModeHTML,
			})
		}
		return fmt.Errorf("send video %s failed: %w, err2: %w", video, err, err2)
	}
	username := videoMsg.Chat.Username
	link := html.EscapeString(fmt.Sprintf("https://t.me/%s/%d", username, videoMsg.MessageId))
	linkedText := fmt.Sprintf(`<a href="%s">%s</a>`, link, html.EscapeString(filepath.Base(video)))
	text := linkedText
	if groupMsg != nil {
		_, _, err = groupMsg.EditCaption(bot, &gotgbot.EditMessageCaptionOpts{
			Caption:   text,
			ParseMode: gotgbot.ParseModeHTML,
		})
	}
	return err
}

func uploadVideos(t *qbit.Torrent, supp *Supp) {
	path := t.ContentPath
	var videos []string
	err := filepath.WalkDir(path, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if helper.IsVideoFile(path) {
			videos = append(videos, path)
		}
		return nil
	})
	if err != nil {
		log.Println(err)
		return
	}
	videos = strnum.SortedStrings(videos)
	log.Printf("prepare to upload %d videos\n", len(videos))
	for _, video := range videos {
		err := uploadOneVideo(video, supp)
		if err != nil {
			log.Println(err)
		}
	}
}
