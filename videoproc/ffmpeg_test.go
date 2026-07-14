package videoproc

import (
	"context"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/vansante/go-ffprobe.v2"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

const videoPath = `testdata/test.mp4`

func TestGetScreenshotAtTime(t *testing.T) {
	as := assert.New(t)
	const time = "00:00:11"
	buf, err := GetScreenshotAtSec(videoPath, timeStrToSec(time))
	as.Nil(err)
	as.NotEmpty(buf)
	as.Equal(buf[:2], []byte{0xff, 0xd8}) // JPEG magic number
	as.Equal(buf[len(buf)-2:], []byte{0xff, 0xd9})
}

func TestMakeScreenShotTile(t *testing.T) {
	as := assert.New(t)
	const tileWidth = 3
	const tileHeight = 3
	buf, err := MakeScreenShotTile(videoPath, tileWidth, tileHeight)
	as.Nil(err)
	as.NotEmpty(buf)
	as.Equal(buf[:2], []byte{0xff, 0xd8}) // JPEG magic number
	as.Equal(buf[len(buf)-2:], []byte{0xff, 0xd9})
}

func TestMain(m *testing.M) {
	FontFilePath = `../static/NotoSans-Regular.ttf`
	os.Exit(m.Run())
}

func TestProbe(t *testing.T) {
	as := assert.New(t)
	probe, err := ffprobe.ProbeURL(context.Background(), videoPath)
	as.Nil(err)
	as.NotNil(probe)
	as.NotEmpty(probe.Format)
	as.NotEmpty(probe.Format.DurationSeconds)
	as.NotNil(probe.FirstVideoStream())
	v := probe.FirstVideoStream()
	as.Equal("25.358333", v.Duration)
	as.Equal("h264", v.CodecName)
	as.Equal(1920, v.Width)
	as.Equal(1080, v.Height)
	as.Equal("yuv420p", v.PixFmt)

}

func TestTranscodeForTelegram(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "input.mkv")
	output := filepath.Join(dir, "output.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-v", "error",
		"-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=1",
		"-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input)
	require.NoError(t, cmd.Run())
	require.NoError(t, TranscodeForTelegram(context.Background(), input, output, true))

	probe, err := ffprobe.ProbeURL(context.Background(), output)
	require.NoError(t, err)
	require.Equal(t, "h264", probe.FirstVideoStream().CodecName)
	require.Equal(t, "aac", probe.FirstAudioStream().CodecName)
}
