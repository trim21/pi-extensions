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

func TestScanSession(t *testing.T) {
	path := writeSessionFile(t, strings.Join([]string{
		`{"type":"session","version":3,"id":"abc","cwd":"/home/user/projects/demo"}`,
		`{"type":"model_change","modelId":"x"}`,
		`{"type":"message","message":{"role":"user","content":"hi"}}`,
		`{"type":"session_info","name":"first title"}`,
		`{"type":"session_info","name":"  final title  "}`,
		``,
	}, "\n"))

	name, cwd, err := scanSession(path)
	if err != nil {
		t.Fatalf("scanSession: %v", err)
	}
	if name != "final title" {
		t.Fatalf("name = %q, want %q", name, "final title")
	}
	if cwd != "/home/user/projects/demo" {
		t.Fatalf("cwd = %q, want %q", cwd, "/home/user/projects/demo")
	}
}

func TestScanSessionToleratesLongLines(t *testing.T) {
	content := `{"type":"session","cwd":"/srv/app"}` + "\n" +
		`{"type":"message","message":{"text":"` + strings.Repeat("a", 512<<10) + `"}}` + "\n" +
		`{"type":"session_info","name":"after long line"}` + "\n"

	name, cwd, err := scanSession(writeSessionFile(t, content))
	if err != nil {
		t.Fatalf("scanSession: %v", err)
	}
	if name != "after long line" {
		t.Fatalf("name = %q, want %q", name, "after long line")
	}
	if cwd != "/srv/app" {
		t.Fatalf("cwd = %q, want %q", cwd, "/srv/app")
	}
}

func TestScanSessionEmptyPath(t *testing.T) {
	name, cwd, err := scanSession("")
	if err != nil {
		t.Fatalf("scanSession(\"\"): %v", err)
	}
	if name != "" || cwd != "" {
		t.Fatalf("scanSession(\"\") = (%q, %q), want empty", name, cwd)
	}
}

func TestScanSessionReportsMissingFile(t *testing.T) {
	_, _, err := scanSession(filepath.Join(t.TempDir(), "missing.jsonl"))
	if err == nil {
		t.Fatal("scanSession on a missing file returned no error")
	}
	if !strings.Contains(err.Error(), "open session file") {
		t.Fatalf("error = %q, want it to mention opening the file", err)
	}
}

func TestScanSessionReportsUnparsableFile(t *testing.T) {
	path := writeSessionFile(t, "not json\n{\"broken\":\n")

	name, cwd, err := scanSession(path)
	if err == nil {
		t.Fatalf("scanSession on garbage returned (%q, %q), want error", name, cwd)
	}
	if !strings.Contains(err.Error(), "no session metadata") {
		t.Fatalf("error = %q, want it to mention missing metadata", err)
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
