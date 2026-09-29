//! Tracks non-preemptible native operations through cancellation settlement.
//! Dropping an async waiter must not leave a write running after run-finished.
use std::sync::Arc;
pub struct Work(tokio::sync::watch::Sender<usize>);
impl Default for Work {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(0).0)
    }
}
pub struct Guard(Arc<Work>);
impl Work {
    pub fn enter(self: &Arc<Self>) -> Guard {
        self.0.send_modify(|n| *n += 1);
        Guard(self.clone())
    }
    pub async fn settle(&self) {
        let mut watch = self.0.subscribe();
        loop {
            if *watch.borrow_and_update() == 0 {
                return;
            }
            if watch.changed().await.is_err() {
                return;
            }
        }
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.0.send_modify(|n| *n -= 1);
    }
}
