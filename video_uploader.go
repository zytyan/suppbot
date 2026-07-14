package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/PaulSonOfLars/gotgbot/v2"
	"github.com/disintegration/imaging"
	"github.com/zytyan/suppbot/helper"
	"github.com/zytyan/suppbot/qbit"
	"github.com/zytyan/suppbot/strnum"
	"github.com/zytyan/suppbot/videoproc"
	"gopkg.in/vansante/go-ffprobe.v2"
	"html"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

var retryAfterPattern = regexp.MustCompile(`(?i)retry after\s+(\d+)`)

const (
	videoBitRateThreshold = int64(12_000_000)
	maxVideoUploadSize    = int64(2_000_000_000)
	containerOverhead     = 1.03
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

func streamBitRate(stream *ffprobe.Stream) (int64, bool) {
	if stream == nil || stream.BitRate == "" {
		return 0, false
	}
	bitRate, err := strconv.ParseInt(stream.BitRate, 10, 64)
	return bitRate, err == nil && bitRate > 0
}

func estimatedTranscodedSize(duration float64, audioBitRate int64) int64 {
	if duration <= 0 {
		return 0
	}
	bits := float64(videoproc.TargetVideoBitRate+audioBitRate) * duration
	return int64(bits / 8 * containerOverhead)
}

func processedVideoName(video string) string {
	return helper.Stem(filepath.Base(video)) + ".mp4"
}

func failVideoRecord(record *SendRecord, err error) error {
	if saveErr := markSendRecordFailed(record, err); saveErr != nil {
		return errors.Join(err, saveErr)
	}
	return err
}

func uploadOneVideo(video, sourcePath string, supp *Supp, torrentRecord *SuppTorrent) error {
	log.Printf("prepare video for channel %d: %s\n", config.VideoChannelId, video)
	probe, err := ffprobe.ProbeURL(context.Background(), video)
	if err != nil {
		return err
	}
	v := probe.FirstVideoStream()
	if v == nil || probe.Format == nil {
		return fmt.Errorf("ffprobe %s returned no video stream or format", video)
	}
	stat, err := os.Stat(video)
	if err != nil {
		return err
	}
	videoBitRate, hasVideoBitRate := streamBitRate(v)
	audio := probe.FirstAudioStream()
	audioBitRate, hasAudioBitRate := streamBitRate(audio)
	copyAAC := audio != nil && audio.CodecName == "aac" && hasAudioBitRate
	if audio != nil && !copyAAC {
		audioBitRate = videoproc.TargetAudioBitRate
	}
	fullTranscode := stat.Size() > maxVideoUploadSize || (hasVideoBitRate && videoBitRate > videoBitRateThreshold)
	needsAudioConversion := audio != nil && !copyAAC
	fileName := filepath.Base(video)
	if fullTranscode || needsAudioConversion {
		fileName = processedVideoName(video)
	}
	record, skip, err := prepareSendRecord(torrentRecord, sourcePath, SendTypeVideo, fileName)
	if err != nil || skip {
		return err
	}

	if fullTranscode {
		if probe.Format.DurationSeconds <= 0 {
			return failVideoRecord(record, errors.New("cannot estimate transcoded size without video duration"))
		}
		estimatedSize := estimatedTranscodedSize(probe.Format.DurationSeconds, audioBitRate)
		if estimatedSize > maxVideoUploadSize {
			reason := fmt.Sprintf("estimated transcoded size %d exceeds limit %d", estimatedSize, maxVideoUploadSize)
			return markSendRecordSkipped(record, reason)
		}
	}

	sendVideo := video
	if fullTranscode || needsAudioConversion {
		tmpDir, tmpErr := os.MkdirTemp("", "suppbot-video-")
		if tmpErr != nil {
			return failVideoRecord(record, tmpErr)
		}
		defer os.RemoveAll(tmpDir)
		sendVideo = filepath.Join(tmpDir, fileName)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Hour)
		defer cancel()
		if fullTranscode {
			trackTorrentWork(supp, torrentRecord.Hash, "视频转码", video, 0, 1, 0, 0, nil)
			err = videoproc.TranscodeForTelegram(ctx, video, sendVideo, copyAAC, func(elapsed time.Duration) {
				progress := elapsed.Seconds() / probe.Format.DurationSeconds
				if progress > 1 {
					progress = 1
				}
				trackTorrentWork(supp, torrentRecord.Hash, "视频转码", video, 0, 1, 0, progress, nil)
			})
		} else {
			trackTorrentWork(supp, torrentRecord.Hash, "音频转换", video, 0, 1, 0, 0, nil)
			err = videoproc.ConvertAudioToAAC(ctx, video, sendVideo, func(elapsed time.Duration) {
				progress := elapsed.Seconds() / probe.Format.DurationSeconds
				if progress > 1 {
					progress = 1
				}
				trackTorrentWork(supp, torrentRecord.Hash, "音频转换", video, 0, 1, 0, progress, nil)
			})
		}
		if err != nil {
			return failVideoRecord(record, err)
		}
		stat, err = os.Stat(sendVideo)
		if err != nil {
			return failVideoRecord(record, err)
		}
		if stat.Size() > maxVideoUploadSize {
			reason := fmt.Sprintf("actual transcoded size %d exceeds limit %d", stat.Size(), maxVideoUploadSize)
			return markSendRecordSkipped(record, reason)
		}
		probe, err = ffprobe.ProbeURL(context.Background(), sendVideo)
		if err != nil {
			return failVideoRecord(record, err)
		}
		v = probe.FirstVideoStream()
		if v == nil || probe.Format == nil {
			return failVideoRecord(record, errors.New("ffprobe returned no stream for processed video"))
		}
	}

	trackTorrentWork(supp, torrentRecord.Hash, "生成视频截图", sendVideo, 0, 1, 0, 1, nil)
	thumbnail, err := videoproc.MakeScreenShotTileFile(sendVideo, 3, 3)
	if err != nil {
		return failVideoRecord(record, err)
	}
	defer os.Remove(thumbnail)
	thumbURL, err := tgThumbnail(thumbnail)
	var thumbnailFile *gotgbot.FileReader
	if err == nil {
		thumbnailFile = gotgbot.InputFileByURL(thumbURL).(*gotgbot.FileReader)
		defer os.Remove(thumbnail + ".thumb.jpg")
	}

	if record.GroupMessageID == 0 {
		groupMsg, sendErr := bot.SendPhoto(supp.LinkedGroupMsg.ChatId, gotgbot.InputFileByURL(fileSchema(thumbnail)), &gotgbot.SendPhotoOpts{
			Caption: filepath.Base(sendVideo), HasSpoiler: true,
			ReplyParameters: &gotgbot.ReplyParameters{MessageId: supp.LinkedGroupMsg.Id, ChatId: supp.LinkedGroupMsg.ChatId},
		})
		if sendErr != nil {
			return failVideoRecord(record, sendErr)
		}
		record.GroupChatID, record.GroupMessageID = groupMsg.Chat.Id, groupMsg.MessageId
		if err := db.Save(record).Error; err != nil {
			return err
		}
	}

	trackTorrentWork(supp, torrentRecord.Hash, "上传视频", sendVideo, 0, 1, 1, 1, nil)
	videoMsg, err := bot.SendVideo(config.VideoChannelId, gotgbot.InputFileByURL(fileSchema(sendVideo)), &gotgbot.SendVideoOpts{
		Caption: filepath.Base(sendVideo) + "\n" + getVideoTechSpecs(probe), Thumbnail: thumbnailFile,
		HasSpoiler: true, Width: int64(v.Width), Height: int64(v.Height), Duration: int64(probe.Format.DurationSeconds), SupportsStreaming: true,
		ReplyParameters: &gotgbot.ReplyParameters{MessageId: record.GroupMessageID, ChatId: record.GroupChatID},
	})
	if err != nil {
		_, _, editErr := bot.EditMessageCaption(&gotgbot.EditMessageCaptionOpts{ChatId: record.GroupChatID, MessageId: record.GroupMessageID, Caption: "视频上传失败"})
		return failVideoRecord(record, errors.Join(fmt.Errorf("send video %s: %w", sendVideo, err), editErr))
	}
	if videoMsg.Video == nil {
		return failVideoRecord(record, errors.New("telegram response has no video"))
	}
	record.Status, record.Error = SendStatusSuccess, ""
	record.FileID, record.FileUniqueID = videoMsg.Video.FileId, videoMsg.Video.FileUniqueId
	record.ChannelChatID, record.ChannelMessageID = videoMsg.Chat.Id, videoMsg.MessageId
	if err := db.Save(record).Error; err != nil {
		return err
	}
	link := html.EscapeString(fmt.Sprintf("https://t.me/%s/%d", videoMsg.Chat.Username, videoMsg.MessageId))
	text := fmt.Sprintf(`<a href="%s">%s</a>`, link, html.EscapeString(filepath.Base(sendVideo)))
	if _, _, editErr := bot.EditMessageCaption(&gotgbot.EditMessageCaptionOpts{ChatId: record.GroupChatID, MessageId: record.GroupMessageID, Caption: text, ParseMode: gotgbot.ParseModeHTML}); editErr != nil {
		log.Printf("edit video link caption failed: %s", editErr)
	}
	return nil
}

func uploadVideos(t *qbit.Torrent, supp *Supp, torrentRecord *SuppTorrent) error {
	path := t.ContentPath
	var videos []string
	err := filepath.Walk(path, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if helper.IsVideoFile(path) {
			videos = append(videos, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	videos = strnum.SortedStrings(videos)
	log.Printf("prepare to upload %d videos\n", len(videos))
	var uploadErr error
	for index, video := range videos {
		trackTorrentWork(supp, torrentRecord.Hash, "处理视频", video, index, len(videos), 0, 1, nil)
		err := uploadVideoWithRetry(video, torrentSourcePath(path, video), supp, torrentRecord, uploadOneVideo, time.Sleep)
		if err != nil {
			log.Println(err)
			uploadErr = errors.Join(uploadErr, err)
		}
	}
	trackTorrentWork(supp, torrentRecord.Hash, "视频处理完成", "", len(videos), len(videos), 0, 1, uploadErr)
	return uploadErr
}

func uploadVideoWithRetry(video, sourcePath string, supp *Supp, torrent *SuppTorrent, upload func(string, string, *Supp, *SuppTorrent) error, sleep func(time.Duration)) error {
	const maxAttempts = 3
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		trackTorrentWork(supp, torrent.Hash, "处理视频", video, 0, 0, attempt, 1, nil)
		lastErr = upload(video, sourcePath, supp, torrent)
		if lastErr == nil {
			return nil
		}
		match := retryAfterPattern.FindStringSubmatch(lastErr.Error())
		if len(match) != 2 || attempt == maxAttempts {
			return lastErr
		}
		seconds, err := strconv.Atoi(match[1])
		if err != nil {
			return lastErr
		}
		sleep(time.Duration(seconds+1) * time.Second)
	}
	return lastErr
}
