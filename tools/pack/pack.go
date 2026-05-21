// pack creates a Mattermost-plugin .tar.gz from a staging directory,
// applying mode 0755 to anything under server/dist/ (executables) and
// 0644 to everything else. Required because Windows bsdtar can't set
// Unix execute bits on files coming from NTFS.
//
// Usage: go run ./tools/pack <staging-dir> <output.tar.gz>
package main

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: pack <staging-dir> <output.tar.gz>")
		os.Exit(2)
	}
	stage := filepath.Clean(os.Args[1])
	outPath := os.Args[2]

	info, err := os.Stat(stage)
	if err != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "staging dir not found: %s\n", stage)
		os.Exit(1)
	}

	out, err := os.Create(outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "create %s: %v\n", outPath, err)
		os.Exit(1)
	}
	defer out.Close()

	gz := gzip.NewWriter(out)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()

	root := filepath.Dir(stage)
	prefix := filepath.Base(stage)

	err = filepath.Walk(stage, func(path string, fi os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		nameInTar := filepath.ToSlash(rel)

		mode := int64(0o644)
		if fi.IsDir() {
			mode = 0o755
		} else if isExecutable(nameInTar, prefix) {
			mode = 0o755
		}

		hdr := &tar.Header{
			Name:    nameInTar,
			Mode:    mode,
			Size:    fi.Size(),
			ModTime: fi.ModTime(),
			Uname:   "plugin",
			Gname:   "plugin",
		}
		if fi.IsDir() {
			hdr.Typeflag = tar.TypeDir
			hdr.Name += "/"
			hdr.Size = 0
		} else {
			hdr.Typeflag = tar.TypeReg
		}

		if err := tw.WriteHeader(hdr); err != nil {
			return fmt.Errorf("write header %s: %w", nameInTar, err)
		}
		if fi.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("open %s: %w", path, err)
		}
		_, copyErr := io.Copy(tw, f)
		closeErr := f.Close()
		if copyErr != nil {
			return fmt.Errorf("copy %s: %w", path, copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close %s: %w", path, closeErr)
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "walk: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("packed %s\n", outPath)
}

// isExecutable returns true for files that should be marked +x in the tar.
// Anything inside server/dist/ is a plugin binary (one per OS/arch).
func isExecutable(nameInTar, prefix string) bool {
	p := strings.TrimPrefix(nameInTar, prefix+"/")
	return strings.HasPrefix(p, "server/dist/")
}
