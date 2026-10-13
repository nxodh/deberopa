// Package vedecaps provides a standard-library client for the Vedecaps HTTP API.
package vedecaps

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	base     string
	password string
	http     *http.Client
}

type Options struct {
	BaseURL    string
	Password   string
	HTTPClient *http.Client
}

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("Vedecaps HTTP %d: %s", e.Status, e.Message) }

func New(options Options) (*Client, error) {
	base := strings.TrimRight(options.BaseURL, "/")
	if base == "" {
		base = "http://127.0.0.1:4096"
	}
	parsed, err := url.Parse(base)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, fmt.Errorf("invalid server URL")
	}
	if parsed.Scheme == "http" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1" {
		return nil, fmt.Errorf("remote servers require HTTPS")
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	copy := *client
	copy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	client = &copy
	return &Client{base: base, password: options.Password, http: client}, nil
}

func (c *Client) request(ctx context.Context, method, path string, body any) (*http.Response, error) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return nil, fmt.Errorf("invalid API path")
	}
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, payload)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.password != "" {
		req.SetBasicAuth("vedecaps", c.password)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
		var decoded struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &decoded)
		return nil, &Error{res.StatusCode, decoded.Error}
	}
	return res, nil
}

// Request covers every API endpoint, including Markdown exports. Use contexts for deadlines.
func (c *Client) Request(ctx context.Context, method, path string, body any) ([]byte, error) {
	res, err := c.request(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

type Session struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Directory string `json:"directory"`
	ParentID  string `json:"parentID,omitempty"`
}
type Prompt struct {
	Text  string `json:"text"`
	Model string `json:"model,omitempty"`
	Agent string `json:"agent,omitempty"`
}
type Event struct {
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
}

func (c *Client) CreateSession(ctx context.Context, title string) (*Session, error) {
	data, err := c.Request(ctx, "POST", "/session", map[string]string{"title": title})
	if err != nil {
		return nil, err
	}
	var session Session
	err = json.Unmarshal(data, &session)
	return &session, err
}
func (c *Client) Prompt(ctx context.Context, id string, prompt Prompt) (json.RawMessage, error) {
	return c.Request(ctx, "POST", "/session/"+url.PathEscape(id)+"/message", prompt)
}
func (c *Client) PromptAsync(ctx context.Context, id string, prompt Prompt) error {
	_, err := c.Request(ctx, "POST", "/session/"+url.PathEscape(id)+"/prompt_async", prompt)
	return err
}
func (c *Client) ReplyPermission(ctx context.Context, id, reply, message string) error {
	if reply != "once" && reply != "always" && reply != "reject" {
		return fmt.Errorf("invalid permission reply")
	}
	_, err := c.Request(ctx, "POST", "/permission/"+url.PathEscape(id), map[string]string{"reply": reply, "message": message})
	return err
}

// Events calls receive for each SSE event until the server closes or ctx is cancelled.
func (c *Client) Events(ctx context.Context, receive func(Event) error) error {
	res, err := c.request(ctx, "GET", "/event", nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 8*1024*1024)
	var lines []string
	size := 0
	for scanner.Scan() {
		line := scanner.Text()
		size += len(line)
		if size > 8*1024*1024 {
			return fmt.Errorf("event frame is too large")
		}
		if line == "" {
			if len(lines) > 0 {
				var event Event
				if err := json.Unmarshal([]byte(strings.Join(lines, "\n")), &event); err != nil {
					return err
				}
				if err := receive(event); err != nil {
					return err
				}
			}
			lines = nil
			size = 0
		} else if strings.HasPrefix(line, "data:") {
			lines = append(lines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	return scanner.Err()
}
