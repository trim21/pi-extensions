package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSessionFile(t *testing.T, content string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNotificationBody(t *testing.T) {
	tests := []struct {
		name  string
		event string
		cwd   string
		want  string
	}{
		{name: "event and project", event: "input_request", cwd: "/home/user/projects/pi-extensions", want: "input_request · pi-extensions"},
		{name: "event only", event: "agent_finished", want: "agent_finished"},
		{name: "project only", cwd: "/srv/app", want: "app"},
		{name: "neither", want: "Pendant notification"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := notificationBody(test.event, test.cwd); got != test.want {
				t.Fatalf("notificationBody(%q, %q) = %q, want %q", test.event, test.cwd, got, test.want)
			}
		})
	}
}

func TestMessageEndpoint(t *testing.T) {
	tests := []struct {
		name    string
		baseURL string
		want    string
	}{
		{name: "plain", baseURL: "https://gotify.example.com", want: "https://gotify.example.com/message"},
		{name: "trailing slash", baseURL: "https://gotify.example.com/", want: "https://gotify.example.com/message"},
		{name: "path prefix", baseURL: "https://example.com/gotify/", want: "https://example.com/gotify/message"},
		{name: "surrounding spaces", baseURL: "  http://127.0.0.1:8080  ", want: "http://127.0.0.1:8080/message"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := messageEndpoint(test.baseURL)
			if err != nil {
				t.Fatalf("messageEndpoint(%q): %v", test.baseURL, err)
			}
			if got != test.want {
				t.Fatalf("messageEndpoint(%q) = %q, want %q", test.baseURL, got, test.want)
			}
		})
	}
}

func TestMessageEndpointRejectsBadInput(t *testing.T) {
	tests := []struct {
		name    string
		baseURL string
	}{
		{name: "empty", baseURL: ""},
		{name: "blank", baseURL: "   "},
		{name: "missing scheme", baseURL: "gotify.example.com"},
		{name: "wrong scheme", baseURL: "ftp://gotify.example.com"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got, err := messageEndpoint(test.baseURL); err == nil {
				t.Fatalf("messageEndpoint(%q) = %q, want error", test.baseURL, got)
			}
		})
	}
}

func TestScanSessionCwd(t *testing.T) {
	path := writeSessionFile(t, strings.Join([]string{
		`{"type":"session","version":3,"id":"abc","cwd":"/home/user/projects/demo"}`,
		`{"type":"session_info","name":"a session title that must be ignored"}`,
		`{"type":"message","message":{"role":"user","content":"hi"}}`,
		``,
	}, "\n"))

	cwd, err := scanSessionCwd(path)
	if err != nil {
		t.Fatalf("scanSessionCwd: %v", err)
	}
	if cwd != "/home/user/projects/demo" {
		t.Fatalf("cwd = %q, want %q", cwd, "/home/user/projects/demo")
	}
}

func TestScanSessionCwdToleratesLongLines(t *testing.T) {
	content := `{"type":"message","message":{"text":"` + strings.Repeat("a", 512<<10) + `"}}` + "\n" +
		`{"type":"session","cwd":"/srv/app"}` + "\n"

	cwd, err := scanSessionCwd(writeSessionFile(t, content))
	if err != nil {
		t.Fatalf("scanSessionCwd: %v", err)
	}
	if cwd != "/srv/app" {
		t.Fatalf("cwd = %q, want %q", cwd, "/srv/app")
	}
}

func TestScanSessionCwdEmptyPath(t *testing.T) {
	cwd, err := scanSessionCwd("")
	if err != nil {
		t.Fatalf("scanSessionCwd(\"\"): %v", err)
	}
	if cwd != "" {
		t.Fatalf("scanSessionCwd(\"\") = %q, want empty", cwd)
	}
}

func TestScanSessionCwdReportsMissingFile(t *testing.T) {
	_, err := scanSessionCwd(filepath.Join(t.TempDir(), "missing.jsonl"))
	if err == nil {
		t.Fatal("scanSessionCwd on a missing file returned no error")
	}
	if !strings.Contains(err.Error(), "open session file") {
		t.Fatalf("error = %q, want it to mention opening the file", err)
	}
}

func TestScanSessionCwdReportsUnparsableFile(t *testing.T) {
	path := writeSessionFile(t, "not json\n{\"broken\":\n")

	cwd, err := scanSessionCwd(path)
	if err == nil {
		t.Fatalf("scanSessionCwd on garbage returned %q, want error", cwd)
	}
	if !strings.Contains(err.Error(), "no session metadata") {
		t.Fatalf("error = %q, want it to mention missing metadata", err)
	}
}

func TestReadPayload(t *testing.T) {
	t.Setenv("PENDANT_EVENT", " input_request ")
	t.Setenv("PENDANT_TITLE", "Pendant")
	t.Setenv("PENDANT_SESSION_NAME", " fix gotify title ")
	t.Setenv("PENDANT_SESSION_PATH", " /tmp/session.jsonl ")

	payload := readPayload()
	if payload.Event != "input_request" {
		t.Errorf("Event = %q, want %q", payload.Event, "input_request")
	}
	if payload.Title != "Pendant" {
		t.Errorf("Title = %q, want %q", payload.Title, "Pendant")
	}
	if payload.SessionName != "fix gotify title" {
		t.Errorf("SessionName = %q, want %q", payload.SessionName, "fix gotify title")
	}
	if payload.SessionPath != "/tmp/session.jsonl" {
		t.Errorf("SessionPath = %q, want %q", payload.SessionPath, "/tmp/session.jsonl")
	}
}

func TestNewClientUsesEnvProxiesByDefault(t *testing.T) {
	transport, ok := newClient(false).Transport.(*http.Transport)
	if !ok {
		t.Fatal("newClient(false) did not return an *http.Transport")
	}
	if transport.Proxy == nil {
		t.Fatal("newClient(false) must keep honouring HTTP_PROXY and friends")
	}
}

func TestNewClientNoProxyBypassesEnvProxies(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("NO_PROXY", "")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if err := postGotify(newClient(true), server.URL+"/message", "secret", "title", "message"); err != nil {
		t.Fatalf("postGotify with the no-proxy client: %v", err)
	}
}

func TestPostGotify(t *testing.T) {
	var (
		gotPath  string
		gotToken string
		gotTitle string
		gotBody  string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
		}
		gotPath = r.URL.Path
		gotToken = r.URL.Query().Get("token")
		gotTitle = r.PostForm.Get("title")
		gotBody = r.PostForm.Get("message")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := &http.Client{Timeout: requestTimeout}
	if err := postGotify(client, server.URL+"/message", "secret", "my session", "input_request · demo"); err != nil {
		t.Fatalf("postGotify: %v", err)
	}

	if gotPath != "/message" {
		t.Errorf("path = %q, want %q", gotPath, "/message")
	}
	if gotToken != "secret" {
		t.Errorf("token = %q, want %q", gotToken, "secret")
	}
	if gotTitle != "my session" {
		t.Errorf("title = %q, want %q", gotTitle, "my session")
	}
	if gotBody != "input_request · demo" {
		t.Errorf("message = %q, want %q", gotBody, "input_request · demo")
	}
}

func TestPostGotifyReportsStatusError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"bad token"}`))
	}))
	defer server.Close()

	client := &http.Client{Timeout: requestTimeout}
	err := postGotify(client, server.URL+"/message", "secret", "title", "message")
	if err == nil {
		t.Fatal("postGotify succeeded, want error")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error = %q, want it to mention 401", err)
	}
	if !strings.Contains(err.Error(), "bad token") {
		t.Fatalf("error = %q, want it to include the response body", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %q, must not leak the token", err)
	}
}

func TestPostGotifyReportsTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := &http.Client{Timeout: 50 * time.Millisecond}
	err := postGotify(client, server.URL+"/message", "secret", "title", "message")
	if err == nil {
		t.Fatal("postGotify succeeded, want timeout error")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %q, want it to report a timeout", err)
	}
}
