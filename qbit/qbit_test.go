package qbit

import (
	"github.com/stretchr/testify/assert"
	"os"
	"strings"
	"testing"
)

func TestClient(t *testing.T) {
	if os.Getenv("SUPPBOT_QBIT_INTEGRATION") == "" {
		t.Skip("set SUPPBOT_QBIT_INTEGRATION=1 to run against localhost:8888")
	}
	as := assert.New(t)
	c := NewClient("http://localhost:8888", "test", "testtest")
	as.NotNil(c)
	err := c.Login()
	as.Nil(err)
	as.NotEmpty(c.cookie)
	err = c.DownloadMagnetUrls([]string{
		"3B1A1469C180F447B77021074DBBCCAEF62611E7",
		"3B1A1469C180F447B77021074DBBCCAEF62611E8",
	})
	as.Nil(err)
	err = c.DownloadMagnetUrl("3B1A1469C180F447B77021074DBBCCAEF62611E9")
	as.Nil(err)
	torrents, err := c.GetTorrents()
	as.Nil(err)
	as.NotEmpty(torrents)
	hasE9 := false
	for _, t := range torrents {
		if strings.ToUpper(t.Hash) == "3B1A1469C180F447B77021074DBBCCAEF62611E9" {
			hasE9 = true
			break
		}
	}
	as.True(hasE9)
	err = c.DeleteTorrents([]string{
		"3B1A1469C180F447B77021074DBBCCAEF62611E7",
		"3B1A1469C180F447B77021074DBBCCAEF62611E8",
		"3B1A1469C180F447B77021074DBBCCAEF62611E9",
	}, true)
	as.Nil(err)
	err = c.Logout()
	as.Nil(err)
}
