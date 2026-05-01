// Broadcast channel for fact-store mutations.
//
// Each subscriber owns an mpsc channel and an optional filter. publish()
// builds a Message (event + ref hint) and only sends to subscribers whose
// filter accepts it. Dropped subscribers are pruned the next time anyone
// publishes.

use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};

#[derive(Clone)]
pub struct Message {
    pub payload: String,
    /// Hint for filtering. None means "broadcast to everyone" — used for
    /// ephemeral events (drafts, pings) that don't carry a ref.
    pub ref_hint: Option<String>,
}

#[derive(Default, Clone)]
pub struct Filter {
    /// When set, subscriber wants chat/<id>/* events plus everything that
    /// isn't chat-scoped (memory/, drafts, pings, anything without a ref).
    pub chat_id: Option<String>,
}

impl Filter {
    pub fn accepts(&self, msg: &Message) -> bool {
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
    tx: Sender<String>,
    filter: Filter,
}

static SUBSCRIBERS: LazyLock<Mutex<Vec<Subscriber>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct Subscription {
    pub id: u64,
    pub rx: Receiver<String>,
}

pub fn subscribe() -> Subscription {
    let (tx, rx) = mpsc::channel();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    SUBSCRIBERS.lock().unwrap().push(Subscriber {
        id,
        tx,
        filter: Filter::default(),
    });
    Subscription { id, rx }
}

pub fn set_filter(id: u64, filter: Filter) {
    if let Ok(mut subs) = SUBSCRIBERS.lock() {
        for sub in subs.iter_mut() {
            if sub.id == id {
                sub.filter = filter;
                return;
            }
        }
    }
}

pub fn publish_msg(msg: Message) {
    let Ok(mut subs) = SUBSCRIBERS.lock() else {
        return;
    };
    subs.retain(|sub| {
        if !sub.filter.accepts(&msg) {
            return true; // not delivered, but subscriber stays alive
        }
        sub.tx.send(msg.payload.clone()).is_ok()
    });
}

pub fn publish(payload: String) {
    publish_msg(Message {
        payload,
        ref_hint: None,
    });
}

pub fn ref_changed(ref_name: &str) {
    publish_msg(Message {
        payload: format!(r#"{{"kind":"ref","ref":{}}}"#, json_string(ref_name)),
        ref_hint: Some(ref_name.to_string()),
    });
}

pub fn facts_changed(ref_name: &str) {
    publish_msg(Message {
        payload: format!(r#"{{"kind":"facts","ref":{}}}"#, json_string(ref_name)),
        ref_hint: Some(ref_name.to_string()),
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
