package qbit

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
)

type StatusCodeError struct {
	Method string
	Path   string
	Code   int
}

func (e *StatusCodeError) Error() string {
	return fmt.Sprintf("http status error: %s %s: %d", e.Method, e.Path, e.Code)
}

type Client struct {
	client   *http.Client
	Host     string
	Username string
	Password string
	cookie   string

	forbiddenCount int
}

func checkOk(r io.Reader) error {
	buf, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if !bytes.Equal(buf, []byte("Ok.")) {
		return errors.New("Qbit return: " + string(buf))
	}
	return nil
}

func checkLoginOk(r io.Reader) error {
	buf, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if len(buf) == 0 || bytes.Equal(buf, []byte("Ok.")) {
		return nil
	}
	return errors.New("Qbit return: " + string(buf))
}

func checkTorrentAddOk(r io.Reader) error {
	buf, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if bytes.Equal(buf, []byte("Ok.")) {
		return nil
	}
	var result struct {
		FailureCount int `json:"failure_count"`
		SuccessCount int `json:"success_count"`
		PendingCount int `json:"pending_count"`
	}
	if err := json.Unmarshal(buf, &result); err == nil && result.FailureCount == 0 && result.SuccessCount+result.PendingCount > 0 {
		return nil
	}
	return errors.New("Qbit return: " + string(buf))
}

func checkEmpty(r io.Reader) error {
	buf, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if len(buf) != 0 {
		return errors.New("Qbit return: " + string(buf))
	}
	return nil
}

func NewClient(host, username, password string) *Client {
	return &Client{
		client:   &http.Client{},
		Host:     host,
		Username: username,
		Password: password,
	}
}

func (c *Client) post(path string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequest("POST", c.Host+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 403 {
		_ = resp.Body.Close()
		c.forbiddenCount++
		if c.forbiddenCount > 3 {
			return nil, errors.New("forbidden count > 3")
		}
		_ = c.Login()
		return c.post(path, body, contentType)
	}
	c.forbiddenCount = 0
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = resp.Body.Close()
		return nil, &StatusCodeError{
			Method: "POST",
			Path:   path,
			Code:   resp.StatusCode,
		}
	}
	return resp, err
}

func (c *Client) postForm(path string, values url.Values) (*http.Response, error) {
	return c.post(path, strings.NewReader(values.Encode()), "application/x-www-form-urlencoded")
}

func (c *Client) postEmpty(path string) (*http.Response, error) {
	return c.post(path, nil, "")
}

func (c *Client) get(path string) (*http.Response, error) {
	req, err := http.NewRequest("GET", c.Host+path, nil)
	if err != nil {
		return nil, err
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 403 {
		_ = resp.Body.Close()
		c.forbiddenCount++
		if c.forbiddenCount > 3 {
			return nil, errors.New("forbidden count > 3")
		}
		_ = c.Login()
		return c.get(path)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_ = resp.Body.Close()
		return nil, &StatusCodeError{
			Method: "GET",
			Code:   resp.StatusCode,
			Path:   path,
		}
	}
	return resp, nil
}

func (c *Client) getParseJson(path string, t any) error {
	resp, err := c.get(path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(t)
}

func (c *Client) Login() error {
	path := "/api/v2/auth/login"
	form := url.Values{
		"username": {c.Username},
		"password": {c.Password},
	}
	c.cookie = ""
	req, err := http.NewRequest("POST", c.Host+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err = checkLoginOk(resp.Body); err != nil {
		return err
	}
	c.cookie = resp.Header.Get("Set-Cookie")
	return nil
}

func (c *Client) Logout() error {
	path := "/api/v2/auth/logout"
	req, err := http.NewRequest("POST", c.Host+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Cookie", c.cookie)
	resp, err := c.client.Do(req)
	c.cookie = ""
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return &StatusCodeError{
			Method: "POST",
			Code:   resp.StatusCode,
		}
	}
	return nil
}

func (c *Client) DownloadMagnetUrls(magnets []string) error {
	path := "/api/v2/torrents/add"
	buf := bytes.NewBuffer(nil)
	form := multipart.NewWriter(buf)
	data := strings.Join(magnets, "\r\n")
	data += "\r\n"
	err := form.WriteField("urls", data)
	if err != nil {
		return err
	}
	err = form.Close()
	if err != nil {
		return err
	}
	resp, err := c.post(path, buf, form.FormDataContentType())
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err = checkTorrentAddOk(resp.Body); err != nil {
		return err
	}
	return nil
}

func (c *Client) DownloadMagnetUrl(magnet string) error {
	return c.DownloadMagnetUrls([]string{magnet})
}

func (c *Client) DeleteTorrents(hashes []string, delFiles bool) error {
	path := "/api/v2/torrents/delete"
	values := url.Values{
		"hashes":      {strings.Join(hashes, "|")},
		"deleteFiles": {fmt.Sprint(delFiles)},
	}
	resp, err := c.postForm(path, values)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return checkEmpty(resp.Body)
}

func (c *Client) DeleteTorrent(hash string, delFiles bool) error {
	return c.DeleteTorrents([]string{hash}, delFiles)
}

func (c *Client) PauseTorrents(hashes []string) error {
	path := "/api/v2/torrents/pause"
	values := url.Values{
		"hashes": {strings.Join(hashes, "|")},
	}
	resp, err := c.postForm(path, values)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return checkEmpty(resp.Body)
}

func (c *Client) PauseTorrent(hash string) error {
	return c.PauseTorrents([]string{hash})
}

func (c *Client) GetTorrents() ([]Torrent, error) {
	path := "/api/v2/torrents/info"
	var torrents []Torrent
	err := c.getParseJson(path, &torrents)
	return torrents, err
}
