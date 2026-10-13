package vedecaps

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAPIAndEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "vedecaps" || password != "fixture-password" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/session":
			fmt.Fprint(w, `{"id":"fixture","title":"Notes"}`)
		case "/session/fixture/message":
			fmt.Fprint(w, `{"role":"assistant","parts":[]}`)
		case "/event":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, ": heartbeat\n\ndata: {\"type\":\"server.connected\",\n data: bad\ndata: \"properties\":{}}\n\n")
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"not found"}`)
		}
	}))
	defer server.Close()
	client, err := New(Options{BaseURL: server.URL, Password: "fixture-password"})
	if err != nil {
		t.Fatal(err)
	}
	session, err := client.CreateSession(context.Background(), "Notes")
	if err != nil || session.ID != "fixture" {
		t.Fatalf("session: %v %v", session, err)
	}
	if _, err := client.Prompt(context.Background(), session.ID, Prompt{Text: "hello"}); err != nil {
		t.Fatal(err)
	}
	count := 0
	if err := client.Events(context.Background(), func(event Event) error {
		count++
		if event.Type != "server.connected" {
			return errors.New("bad event")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("missing event")
	}
	_, err = client.Request(context.Background(), "GET", "/missing", nil)
	var apiError *Error
	if !errors.As(err, &apiError) || apiError.Status != 404 {
		t.Fatalf("error: %v", err)
	}
}

func TestRedirectCannotForwardCredentials(t *testing.T) {
	hit := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	client, _ := New(Options{BaseURL: source.URL, Password: "fixture-password"})
	_, err := client.Request(context.Background(), "GET", "/", nil)
	if err == nil || hit {
		t.Fatal("followed credential-bearing redirect")
	}
}
