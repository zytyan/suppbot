package tphup

import (
	"bytes"
	"fmt"
	"github.com/celestix/telegraph-go/v2"
	"github.com/cenkalti/backoff/v4"
	"github.com/disintegration/imaging"
	"github.com/zytyan/suppbot/helper"
	"github.com/zytyan/suppbot/strnum"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 加载webp
import _ "golang.org/x/image/webp"

func isUploadableExt(filename string) bool {
	ext := filepath.Ext(filename)
	ext = strings.ToLower(ext)
	switch ext {
	case ".jpg", ".jpeg", ".png":
		return true
	default:
		return false
	}
}

func ensureImageCanBeUploaded(filename string) ([]byte, error) {
	image, err := imaging.Open(filename)
	if err != nil {
		return nil, err
	}

	bounds := image.Bounds()
	const MaxLength = 3500
	const MaxFileSize = 5 * 1024 * 1024
	stat, err := os.Stat(filename)
	if err != nil {
		return nil, err
	}

	if stat.Size() < MaxFileSize && bounds.Dx() < MaxLength && bounds.Dy() < MaxLength && isUploadableExt(filename) {
		buf, err := os.ReadFile(filename)
		if err != nil {
			return nil, err
		}
		return buf, nil
	}
	if bounds.Dx() > MaxLength || bounds.Dy() > MaxLength {
		var width, height int
		if bounds.Dx() > bounds.Dy() {
			width = MaxLength
			height = int(float64(bounds.Dy()*MaxLength) / float64(bounds.Dx()))
		} else {
			height = MaxLength
			width = int(float64(bounds.Dx()*MaxLength) / float64(bounds.Dy()))
		}
		image = imaging.Resize(image, width, height, imaging.Lanczos)
	}
	buf := bytes.NewBuffer(nil)
	for quality := 90; quality >= 60; quality -= 5 {
		err = imaging.Encode(buf, image, imaging.JPEG, imaging.JPEGQuality(quality))
		if err != nil {
			return nil, err
		}
		if buf.Len() < MaxFileSize {
			return buf.Bytes(), nil
		}
		buf.Reset()
	}
	return nil, fmt.Errorf("image file %s too large", filename)
}

type LocalError struct {
	Err error
}

func (e LocalError) Error() string {
	return "LocalError"
}

func uploadImageList(client *telegraph.TelegraphClient, filenames []string) ([]string, error) {
	var urls []string
	expBackoff := backoff.NewExponentialBackOff(
		backoff.WithInitialInterval(60*time.Second),
		backoff.WithMaxInterval(20*time.Minute),
		backoff.WithMultiplier(2),
	)
mainLoop:
	for _, filename := range filenames {
		buf, err := ensureImageCanBeUploaded(filename)
		if err != nil {
			log.Printf("error reading or resizing image %s: %v", filename, err)
			continue
		}
		var url string
		for i := 0; ; i++ {
			url, err = client.UploadFileByBytes(buf)
			if err == nil {
				break
			}
			log.Printf("error uploading image %s: %v", filename, err)
			time.Sleep(expBackoff.NextBackOff())
			if i > 20 {
				log.Printf("error uploading image %s: %v, skip upload this image", filename, err)
				break mainLoop
			}
		}
		expBackoff.Reset()
		urls = append(urls, url)
	}
	return urls, nil
}
func filepathIsImage(filename string) bool {
	ext := filepath.Ext(filename)
	ext = strings.ToLower(ext)
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp", ".bmp":
		return true
	default:
		return false
	}
}

func getImageChunks(folder string) ([][]string, error) {
	var filenames []string
	dir, err := os.ReadDir(folder)
	if err != nil {
		return nil, err
	}
	for _, file := range dir {
		if file.IsDir() {
			continue
		}
		if filepathIsImage(file.Name()) {
			filenames = append(filenames, filepath.Join(folder, file.Name()))
		}
	}
	filenames = strnum.SortedStrings(filenames)
	return helper.Chunk(filenames, 90), nil
}

func UploadFolder(client *telegraph.TelegraphClient, accessToken, folder string) (chan *telegraph.Page, error) {
	title := filepath.Base(folder)
	chunk, err := getImageChunks(folder)
	if err != nil {
		return nil, err
	}
	ch := make(chan *telegraph.Page, 8)
	go func() {
		defer close(ch)
		for idx, filenames := range chunk {
			if len(chunk) > 1 {
				title = fmt.Sprintf("%s (%d / %d)", title, idx+1, len(chunk))
			}
			urls, err := uploadImageList(client, filenames)
			if err != nil {
				log.Printf("error uploading image list: %v", err)
				continue
			}
			nodes := make([]string, 0, len(urls))
			for _, url := range urls {
				node := fmt.Sprintf(`<img src="%s"/>`, url)
				nodes = append(nodes, node)
			}
			content := fmt.Sprintf(`<p>%s</p>`, strings.Join(nodes, ""))
			page, err := client.CreatePage(accessToken, title, content, nil)
			if err != nil {
				log.Printf("error creating page: %v", err)
				continue
			}
			ch <- page
		}
	}()
	return ch, nil
}
