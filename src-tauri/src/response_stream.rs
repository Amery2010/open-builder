use std::future::Future;
use std::time::Duration;

use crate::timeouts::wait_with_timeout_retries;
use futures_util::{Stream, StreamExt};

/// Forward each chunk only after the consumer accepts the previous one. Active
/// streams have no total duration, byte, or rate budget; idle peers still fail.
pub(crate) async fn forward_response_stream<S, B, F, Fut>(
    mut stream: S,
    idle_timeout: Duration,
    idle_message: &'static str,
    mut emit: F,
) -> Result<(), String>
where
    S: Stream<Item = Result<B, String>> + Unpin,
    F: FnMut(B) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    loop {
        let next = wait_with_timeout_retries(stream.next(), idle_timeout)
            .await
            .map_err(|_| idle_message.to_string())?;
        let Some(chunk) = next else {
            return Ok(());
        };
        emit(chunk?).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const CHUNK: &[u8] = &[0; 256 * 1024];

    #[tokio::test(start_paused = true)]
    async fn active_stream_passes_old_total_time_and_byte_limits() {
        let stream = Box::pin(stream::unfold(0, |index| async move {
            if index == 300 {
                return None;
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
            Some((Ok(CHUNK), index + 1))
        }));
        let started = tokio::time::Instant::now();
        let mut bytes = 0;
        forward_response_stream(stream, Duration::from_secs(60), "idle", |chunk| {
            bytes += chunk.len();
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
        assert_eq!(bytes, 75 * 1024 * 1024);
        assert!(started.elapsed() > Duration::from_secs(30 * 60));
    }

    #[tokio::test]
    async fn a_fast_stream_uses_consumer_backpressure_without_rate_cutoffs() {
        let chunks = stream::iter((0..300).map(|_| Ok(CHUNK)));
        let mut received = 0;
        forward_response_stream(chunks, Duration::from_secs(60), "idle", |_| {
            received += 1;
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
        assert_eq!(received, 300);
    }

    #[tokio::test(start_paused = true)]
    async fn idle_sources_and_failed_consumers_still_stop() {
        let started = tokio::time::Instant::now();
        let idle = forward_response_stream(
            stream::pending::<Result<u8, String>>(),
            Duration::from_secs(60),
            "idle source",
            |_| std::future::ready(Ok(())),
        )
        .await;
        assert_eq!(idle, Err("idle source".to_string()));
        assert_eq!(started.elapsed(), Duration::from_secs(180));
        let mut received = 0;
        let consumer = forward_response_stream(
            stream::iter([Ok(1), Ok(2)]),
            Duration::from_secs(60),
            "idle",
            |_| {
                received += 1;
                std::future::ready(Err("consumer closed".to_string()))
            },
        )
        .await;
        assert_eq!(consumer, Err("consumer closed".to_string()));
        assert_eq!(received, 1);
        let source = forward_response_stream(
            stream::iter([Err::<u8, _>("source failed".to_string())]),
            Duration::from_secs(60),
            "idle",
            |_| std::future::ready(Ok(())),
        )
        .await;
        assert_eq!(source, Err("source failed".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_the_connection_stops_forwarding() {
        let received = Arc::new(AtomicUsize::new(0));
        let emitted = received.clone();
        let (first, wait_first) = tokio::sync::oneshot::channel();
        let mut first = Some(first);
        let source = Box::pin(stream::unfold((), |()| async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Some((Ok(1_u8), ()))
        }));
        let task = tokio::spawn(forward_response_stream(
            source,
            Duration::from_secs(60),
            "idle",
            move |_| {
                emitted.fetch_add(1, Ordering::Relaxed);
                if let Some(first) = first.take() {
                    let _ = first.send(());
                }
                std::future::ready(Ok(()))
            },
        ));
        wait_first.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::advance(Duration::from_secs(120)).await;
        assert_eq!(received.load(Ordering::Relaxed), 1);
    }
}
