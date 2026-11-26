package jobs

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/yang0/handraw-client/internal/store"
)

// #177 audit item #5: overflow enqueues must unblock on context cancellation
// and be awaited cleanly by Wait() without leaking goroutines.
func TestEnqueueOverflowCancelsCleanlyOnShutdown(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	m := New(db, nil, nil)
	m.mu.Lock()
	m.runCtx = ctx
	m.mu.Unlock()

	// Fill the buffered queue completely without starting workers so subsequent
	// enqueues hit the overflow goroutine path.
	for i := 0; i < cap(m.queue); i++ {
		m.queue <- "fill"
	}
	for i := 0; i < 16; i++ {
		m.Enqueue("overflow")
	}

	cancel()
	done := make(chan struct{})
	go func() {
		m.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Wait() timed out: overflow enqueue goroutines leaked after context cancel")
	}
}
