package main

import (
	_ "embed"
	"errors"
	"os"
	"path/filepath"
)

//go:embed no_image.png
var noImagePNG []byte

func noImageFile() (string, error) {
	path := filepath.Join(os.TempDir(), "suppbot_no_image.png")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return path, os.WriteFile(path, noImagePNG, 0644)
}
