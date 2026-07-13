package qbit

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCheckTorrentAddOk(t *testing.T) {
	require.NoError(t, checkTorrentAddOk(strings.NewReader("Ok.")))
	require.NoError(t, checkTorrentAddOk(strings.NewReader(`{"added_torrent_ids":["abc"],"failure_count":0,"pending_count":0,"success_count":1}`)))
	require.NoError(t, checkTorrentAddOk(strings.NewReader(`{"added_torrent_ids":[],"failure_count":0,"pending_count":1,"success_count":0}`)))
	require.Error(t, checkTorrentAddOk(strings.NewReader(`{"failure_count":1,"pending_count":0,"success_count":0}`)))
	require.Error(t, checkTorrentAddOk(strings.NewReader("unexpected")))
}
