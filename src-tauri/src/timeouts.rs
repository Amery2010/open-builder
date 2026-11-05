use std::future::Future;
use std::time::Duration;

pub(crate) const TIMEOUT_ATTEMPTS: u32 = 3;

/// A timeout does not prove the peer stopped working. Retry waiting for the
/// same operation so committed writes and provider requests are not replayed.
pub(crate) async fn wait_with_timeout_retries<F: Future>(
    future: F,
    timeout: Duration,
) -> Result<F::Output, tokio::time::error::Elapsed> {
    tokio::pin!(future);
    let mut attempt = 1;
    loop {
        match tokio::time::timeout(timeout, future.as_mut()).await {
            Err(_) if attempt < TIMEOUT_ATTEMPTS => attempt += 1,
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test(start_paused = true)]
    async fn a_later_window_can_complete_the_same_operation() {
        let starts = AtomicUsize::new(0);
        let result = wait_with_timeout_retries(
            async {
                starts.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_secs(21)).await;
                "saved"
            },
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(result.unwrap(), "saved");
        assert_eq!(starts.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn three_timeouts_fail_without_restarting_the_operation() {
        let started = tokio::time::Instant::now();
        assert!(
            wait_with_timeout_retries(std::future::pending::<()>(), Duration::from_secs(10),)
                .await
                .is_err()
        );
        assert_eq!(started.elapsed(), Duration::from_secs(30));
        let failed = wait_with_timeout_retries(
            std::future::ready(Err::<(), _>("permission denied")),
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(failed.unwrap(), Err("permission denied"));
        assert_eq!(started.elapsed(), Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_during_retry_wait_returns_immediately() {
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        let started = tokio::time::Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(12)).await;
            let _ = cancel.send(());
        });
        let result = wait_with_timeout_retries(cancelled, Duration::from_secs(10)).await;
        assert!(result.unwrap().is_ok());
        assert_eq!(started.elapsed(), Duration::from_secs(12));
    }
}
