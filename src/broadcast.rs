// Broadcast channel for fact-store mutations.
//
// Each subscriber owns an mpsc channel and an optional filter. publish()
// builds a Message (event + ref hint) and only sends to subscribers whose
// filter accepts it. Dropped subscribers are pruned the next time anyone
// publishes.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};

use serde_json::Value;

#[derive(Clone)]
pub struct Message {
    pub payload: String,
    /// Hint for filtering. None means "broadcast to everyone" — used for
    /// ephemeral events (drafts, pings) that don't carry a ref, subject to
    /// per-stream opt-ins below.
    pub ref_hint: Option<String>,
    /// V8 worker lifecycle events are high-volume diagnostics; clients must
    /// explicitly opt in (the V8 tab does this while visible).
    pub v8: bool,
}

#[derive(Default, Clone)]
pub struct Filter {
    /// When set, subscriber wants chat/<id>/* events plus everything that
    /// isn't chat-scoped (memory/, drafts, pings, anything without a ref).
    pub chat_id: Option<String>,
    pub include_v8: bool,
}

impl Filter {
    pub fn accepts(&self, msg: &Message) -> bool {
        if msg.v8 && !self.include_v8 {
            return false;
        }
        let Some(chat_id) = &self.chat_id else {
            return true;
        };
        let Some(ref_hint) = &msg.ref_hint else {
            return true;
        };
        if !ref_hint.starts_with("chat/") {
            return true;
        }
        ref_hint
            .strip_prefix("chat/")
            .and_then(|rest| rest.split('/').next())
            .map(|id| id == chat_id)
            .unwrap_or(false)
    }
}

struct Subscriber {
    id: u64,
    tx: SyncSender<String>,
    filter: Filter,
}

/// Bound per-subscriber queues so a stalled (non-reading) client can't grow the
/// heap without limit. On overflow we drop the newest event; the client
/// reconciles on its next refresh/reconnect since events are invalidation hints.
const SUBSCRIBER_QUEUE_CAPACITY: usize = 1024;

static SUBSCRIBERS: LazyLock<Mutex<Vec<Subscriber>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static ACTIVE_DRAFTS: LazyLock<Mutex<HashMap<String, HashMap<String, String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct Subscription {
    pub id: u64,
    pub rx: Receiver<String>,
}

pub fn subscribe() -> Subscription {
    let (tx, rx) = mpsc::sync_channel(SUBSCRIBER_QUEUE_CAPACITY);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    SUBSCRIBERS.lock().unwrap().push(Subscriber {
        id,
        tx,
        filter: Filter::default(),
    });
    Subscription { id, rx }
}

pub fn set_filter(id: u64, filter: Filter) -> Vec<String> {
    let replay = active_drafts_for_filter(&filter);
    replace_filter(id, filter);
    replay
}

pub fn set_filter_without_replay(id: u64, filter: Filter) {
    replace_filter(id, filter);
}

fn replace_filter(id: u64, filter: Filter) -> bool {
    if let Ok(mut subs) = SUBSCRIBERS.lock() {
        for sub in subs.iter_mut() {
            if sub.id == id {
                sub.filter = filter;
                return true;
            }
        }
    }
    false
}

pub fn publish_msg(msg: Message) {
    remember_active_draft(&msg.payload);
    let Ok(mut subs) = SUBSCRIBERS.lock() else {
        return;
    };
    subs.retain(|sub| {
        if !sub.filter.accepts(&msg) {
            return true; // not delivered, but subscriber stays alive
        }
        match sub.tx.try_send(msg.payload.clone()) {
            Ok(()) => true,
            // Slow client: drop this event but keep the subscriber alive.
            Err(mpsc::TrySendError::Full(_)) => true,
            // Receiver gone: prune the subscriber.
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        }
    });
}

pub fn publish(payload: String) {
    publish_msg(Message {
        payload,
        ref_hint: None,
        v8: false,
    });
}

pub fn publish_v8(payload: String) {
    publish_msg(Message {
        payload,
        ref_hint: None,
        v8: true,
    });
}

fn active_drafts_for_filter(filter: &Filter) -> Vec<String> {
    let Some(chat_id) = filter.chat_id.as_deref() else {
        return Vec::new();
    };
    let Ok(drafts) = ACTIVE_DRAFTS.lock() else {
        return Vec::new();
    };
    let Some(chat_drafts) = drafts.get(chat_id) else {
        return Vec::new();
    };
    chat_drafts.values().cloned().collect()
}

fn remember_active_draft(payload: &str) {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return;
    };
    let Some(kind) = value.get("kind").and_then(Value::as_str) else {
        return;
    };
    match kind {
        "draft" | "reasoning-draft" | "compaction-draft" => {
            let Some(chat_id) = value.get("chatId").and_then(Value::as_str) else {
                return;
            };
            let Some(draft_id) = value.get("draftId").and_then(Value::as_str) else {
                return;
            };
            if let Ok(mut drafts) = ACTIVE_DRAFTS.lock() {
                drafts
                    .entry(chat_id.to_string())
                    .or_default()
                    .insert(draft_id.to_string(), payload.to_string());
            }
        }
        "draft-end" => {
            let Some(draft_id) = value.get("draftId").and_then(Value::as_str) else {
                return;
            };
            if let Ok(mut drafts) = ACTIVE_DRAFTS.lock() {
                if let Some(chat_id) = value.get("chatId").and_then(Value::as_str) {
                    if let Some(chat_drafts) = drafts.get_mut(chat_id) {
                        chat_drafts.remove(draft_id);
                        if chat_drafts.is_empty() {
                            drafts.remove(chat_id);
                        }
                    }
                    return;
                }
                drafts.retain(|_, chat_drafts| {
                    chat_drafts.remove(draft_id);
                    !chat_drafts.is_empty()
                });
            }
        }
        _ => {}
    }
}

pub fn pointer_changed(name: &str) {
    publish_msg(Message {
        payload: format!(r#"{{"kind":"pointer","pointer":{}}}"#, json_string(name)),
        ref_hint: Some(name.to_string()),
        v8: false,
    });
}

pub fn facts_changed(store: &str) {
    publish_msg(Message {
        payload: format!(r#"{{"kind":"facts","store":{}}}"#, json_string(store)),
        ref_hint: Some(store.to_string()),
        v8: false,
    });
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests mutate the process-global ACTIVE_DRAFTS, so they must not run
    // concurrently. Serialize them on a shared lock (recovering from poison so
    // one failing test doesn't cascade into the others).
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn clear_active_drafts() {
        ACTIVE_DRAFTS.lock().unwrap().clear();
    }

    #[test]
    fn replays_latest_active_draft_for_chat_filter() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_active_drafts();
        publish(
            r#"{"kind":"draft","chatId":"chat1","draftId":"draft1","content":"hel","at":1}"#
                .to_string(),
        );
        publish(
            r#"{"kind":"draft","chatId":"chat1","draftId":"draft1","content":"hello","at":2}"#
                .to_string(),
        );
        publish(
            r#"{"kind":"draft","chatId":"chat2","draftId":"draft2","content":"other","at":3}"#
                .to_string(),
        );

        let replay = active_drafts_for_filter(&Filter {
            chat_id: Some("chat1".to_string()),
            ..Filter::default()
        });

        assert_eq!(replay.len(), 1);
        assert!(replay[0].contains(r#""content":"hello""#));
        assert!(replay[0].contains(r#""draftId":"draft1""#));
    }

    #[test]
    fn draft_end_removes_replay() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_active_drafts();
        publish(r#"{"kind":"reasoning-draft","chatId":"chat1","draftId":"draft1","content":"","reasoningContent":"thinking"}"#.to_string());
        publish(r#"{"kind":"draft-end","chatId":"chat1","draftId":"draft1"}"#.to_string());

        let replay = active_drafts_for_filter(&Filter {
            chat_id: Some("chat1".to_string()),
            ..Filter::default()
        });

        assert!(replay.is_empty());
    }

    #[test]
    fn v8_events_require_explicit_filter_opt_in() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_active_drafts();
        let msg = Message {
            payload: r#"{"kind":"v8","event":{}}"#.to_string(),
            ref_hint: None,
            v8: true,
        };

        assert!(!Filter::default().accepts(&msg));
        assert!(
            Filter {
                include_v8: true,
                ..Filter::default()
            }
            .accepts(&msg)
        );
    }
}
