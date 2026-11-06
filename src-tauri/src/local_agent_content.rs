//! Reconcile provider block snapshots with text already delivered to the host.
use std::collections::BTreeMap;

use crate::local_agent::{LocalAgentEvent, TrackedChannel};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ContentKind {
    Text,
    Thinking,
}

#[derive(Default)]
pub(crate) struct ContentBlocks {
    blocks: BTreeMap<(u64, ContentKind), String>,
    last_emitted: BTreeMap<ContentKind, u64>,
}

impl ContentBlocks {
    fn check_order(&mut self, index: u64, kind: ContentKind, delta: &str) -> Result<(), String> {
        if delta.is_empty() {
            return Ok(());
        }
        if self
            .last_emitted
            .get(&kind)
            .is_some_and(|last| *last > index)
        {
            return Err(
                "local CLI protocol added text to an earlier completed content block".to_string(),
            );
        }
        self.last_emitted.insert(kind, index);
        Ok(())
    }

    pub(crate) fn append(
        &mut self,
        index: u64,
        kind: ContentKind,
        delta: &str,
    ) -> Result<String, String> {
        self.check_order(index, kind, delta)?;
        if !delta.is_empty() {
            self.blocks
                .entry((index, kind))
                .or_default()
                .push_str(delta);
        }
        Ok(delta.to_string())
    }

    pub(crate) fn snapshot(
        &mut self,
        index: u64,
        kind: ContentKind,
        text: &str,
    ) -> Result<String, String> {
        let previous = self
            .blocks
            .get(&(index, kind))
            .map(String::as_str)
            .unwrap_or("");
        let suffix = snapshot_suffix(previous, text)?;
        self.check_order(index, kind, &suffix)?;
        self.blocks
            .entry((index, kind))
            .or_default()
            .push_str(&suffix);
        Ok(suffix)
    }

    pub(crate) fn matches_snapshot(&self, index: u64, kind: ContentKind, text: &str) -> bool {
        self.blocks
            .get(&(index, kind))
            .is_some_and(|previous| text.starts_with(previous))
    }

    pub(crate) fn text(&self, kind: ContentKind) -> String {
        self.blocks
            .iter()
            .filter(|((_, k), _)| *k == kind)
            .map(|(_, text)| text.as_str())
            .collect()
    }
}

pub(crate) fn snapshot_suffix(previous: &str, text: &str) -> Result<String, String> {
    text.strip_prefix(previous)
        .map(str::to_string)
        .ok_or_else(|| "local CLI protocol emitted a conflicting content snapshot".to_string())
}

pub(crate) fn emit_content(
    channel: &TrackedChannel,
    kind: ContentKind,
    delta: String,
) -> Result<(), String> {
    if delta.is_empty() {
        return Ok(());
    }
    let event = match kind {
        ContentKind::Text => LocalAgentEvent::TextDelta { delta },
        ContentKind::Thinking => LocalAgentEvent::ReasoningDelta { delta },
    };
    channel
        .send(event)
        .map_err(|_| "local agent event consumer is unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reconciles_unicode_blocks_without_dropping_repeated_deltas() {
        let mut blocks = ContentBlocks::default();
        assert_eq!(blocks.append(0, ContentKind::Thinking, "思").unwrap(), "思");
        assert_eq!(blocks.append(0, ContentKind::Thinking, "思").unwrap(), "思");
        assert_eq!(
            blocks
                .snapshot(0, ContentKind::Thinking, "思思考🦀")
                .unwrap(),
            "考🦀"
        );
        assert_eq!(
            blocks
                .snapshot(0, ContentKind::Thinking, "思思考🦀")
                .unwrap(),
            ""
        );
        assert_eq!(
            blocks.snapshot(1, ContentKind::Text, "答案").unwrap(),
            "答案"
        );
        assert!(blocks.snapshot(0, ContentKind::Thinking, "思").is_err());
        assert_eq!(blocks.text(ContentKind::Thinking), "思思考🦀");
    }
    #[test]
    fn late_prefix_completion_cannot_corrupt_already_emitted_later_blocks() {
        let mut blocks = ContentBlocks::default();
        blocks.append(0, ContentKind::Text, "first").unwrap();
        blocks.append(1, ContentKind::Text, "second").unwrap();
        assert!(blocks.snapshot(0, ContentKind::Text, "first tail").is_err());
        assert_eq!(blocks.text(ContentKind::Text), "firstsecond");
        assert_eq!(
            blocks
                .snapshot(1, ContentKind::Text, "second tail")
                .unwrap(),
            " tail"
        );
    }
}
