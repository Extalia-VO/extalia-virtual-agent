//! Isolation between tests that hold store locks in the test process and tests that spawn
//! the daemon binary.
//!
//! Store locks are `flock`-style locks on a lock file and belong to its open file
//! description. Spawning a child duplicates every open descriptor of the test process into
//! the child until it executes the new program (where close-on-exec drops them), so for a
//! moment the child shares every lock this process holds. A test that releases a lock in
//! that moment and takes it again (in process, or through a daemon it starts) finds it still
//! held and fails with `index_locked` (or exit status 4). The daemon itself never spawns.
//!
//! Tests that hold locks in process run under [`holds_locks`] (concurrently with each
//! other); tests that spawn the binary run under [`spawns_daemon`], alone. A test takes one
//! of the two, for its whole duration (the `TempDir` helpers keep it), never both.

use std::sync::{Condvar, Mutex, PoisonError};

/// (tests holding locks, a spawning test runs)
static STATE: Mutex<(usize, bool)> = Mutex::new((0, false));
static CHANGED: Condvar = Condvar::new();

/// Held while a test may hold store locks in this process. Never waits for another holder.
#[must_use]
pub struct LockHolder(());

/// Held while a test spawns the daemon binary: no [`LockHolder`] exists meanwhile.
#[must_use]
pub struct Spawner(());

pub fn holds_locks() -> LockHolder {
    let mut state = STATE.lock().unwrap_or_else(PoisonError::into_inner);
    while state.1 {
        state = CHANGED.wait(state).unwrap_or_else(PoisonError::into_inner);
    }
    state.0 += 1;
    LockHolder(())
}

pub fn spawns_daemon() -> Spawner {
    let mut state = STATE.lock().unwrap_or_else(PoisonError::into_inner);
    while state.1 || state.0 > 0 {
        state = CHANGED.wait(state).unwrap_or_else(PoisonError::into_inner);
    }
    state.1 = true;
    Spawner(())
}

impl Drop for LockHolder {
    fn drop(&mut self) {
        STATE.lock().unwrap_or_else(PoisonError::into_inner).0 -= 1;
        CHANGED.notify_all();
    }
}

impl Drop for Spawner {
    fn drop(&mut self) {
        STATE.lock().unwrap_or_else(PoisonError::into_inner).1 = false;
        CHANGED.notify_all();
    }
}

/// Which of the two a test holds.
pub enum Isolation {
    HoldsLocks(#[allow(dead_code)] LockHolder),
    SpawnsDaemon(#[allow(dead_code)] Spawner),
}
