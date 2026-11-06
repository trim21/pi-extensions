// Command pi-notify turns a Pendant hook event into a gotify push.
//
// Pendant runs it with PENDANT_EVENT, PENDANT_TITLE and PENDANT_SESSION_PATH in
// the environment. The session title is read from the pi session JSONL file,
// because Pendant reports the constant "Pendant" as the notification title.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultTitle   = "Pendant"
	requestTimeout = 8 * time.Second
	maxLineSize    = 4 << 20
)

type hookPayload struct {
	Event       string
	Title       string
	SessionPath string
}

type sessionRecord struct {
	Type string `json:"type"`
	Name string `json:"name"`
	CWD  string `json:"cwd"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "pi-notify: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	baseURL := flag.String("url", "", "gotify base URL, for example https://gotify.example.com")
	token := flag.String("token", "", "gotify application token")
	flag.Parse()

	endpoint, err := messageEndpoint(*baseURL)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*token) == "" {
		return errors.New("-token is required")
	}

	payload := readPayload()
	if payload.Event == "" && payload.SessionPath == "" {
		return errors.New("no PENDANT_* environment variables set, refusing to send an empty notification")
	}

	// A missing or unreadable session file only costs us the notification
	// title, so report it and keep going instead of dropping the event.
	sessionName, cwd, sessionErr := scanSession(payload.SessionPath)
	if sessionErr != nil {
		fmt.Fprintf(os.Stderr, "pi-notify: session metadata unavailable: %v\n", sessionErr)
	}

	title := firstNonEmpty(sessionName, payload.Title, defaultTitle)
	body := notificationBody(payload.Event, cwd)

	client := &http.Client{Timeout: requestTimeout}
	if err := postGotify(client, endpoint, *token, title, body); err != nil {
		return err
	}

	return nil
}

func readPayload() hookPayload {
	return hookPayload{
		Event:       strings.TrimSpace(os.Getenv("PENDANT_EVENT")),
		Title:       strings.TrimSpace(os.Getenv("PENDANT_TITLE")),
		SessionPath: strings.TrimSpace(os.Getenv("PENDANT_SESSION_PATH")),
	}
}

func messageEndpoint(baseURL string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return "", errors.New("-url is required")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid -url %q: %w", trimmed, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("invalid -url %q: scheme must be http or https", trimmed)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("invalid -url %q: missing host", trimmed)
	}

	return trimmed + "/message", nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func notificationBody(event, cwd string) string {
	project := ""
	if cwd != "" {
		project = filepath.Base(cwd)
	}

	switch {
	case event != "" && project != "":
		return event + " · " + project
	case event != "":
		return event
	case project != "":
		return project
	default:
		return defaultTitle + " notification"
	}
}

// scanSession collects the latest session name and workspace cwd from the pi
// session JSONL file. Records are appended over a session's lifetime, so the
// last session_info record wins. The returned values are still usable when err
// is set.
func scanSession(path string) (string, string, error) {
	if path == "" {
		return "", "", nil
	}

	file, err := os.Open(path)
	if err != nil {
		return "", "", fmt.Errorf("open session file: %w", err)
	}
	defer file.Close()

	var name, cwd string
	var malformed int
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineSize)
	for scanner.Scan() {
		var record sessionRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			malformed++
			continue
		}

		switch record.Type {
		case "session":
			if cwd == "" {
				cwd = strings.TrimSpace(record.CWD)
			}
		case "session_info":
			if trimmed := strings.TrimSpace(record.Name); trimmed != "" {
				name = trimmed
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return name, cwd, fmt.Errorf("read session file %s: %w", path, err)
	}
	if name == "" && cwd == "" && malformed > 0 {
		return "", "", fmt.Errorf("no session metadata in %s (%d malformed lines)", path, malformed)
	}

	return name, cwd, nil
}

func postGotify(client *http.Client, endpoint, token, title, message string) error {
	form := url.Values{"title": {title}, "message": {message}}

	request, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("build gotify request for %s: %w", endpoint, err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// The token goes in the query string, so keep it out of every error message
	// by only ever reporting the endpoint.
	request.URL.RawQuery = url.Values{"token": {token}}.Encode()

	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("POST %s: timed out after %s", endpoint, requestTimeout)
		}
		return fmt.Errorf("POST %s: %w", endpoint, err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		detail, readErr := io.ReadAll(io.LimitReader(response.Body, 512))
		reason := strings.TrimSpace(string(detail))
		if readErr != nil {
			reason = fmt.Sprintf("could not read response body: %v", readErr)
		}
		return fmt.Errorf("POST %s: unexpected status %s: %s", endpoint, response.Status, reason)
	}

	return nil
}
