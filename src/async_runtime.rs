// Process-wide Tokio runtime, used by ops that need async I/O (LLM streaming,
// the chat driver). V8 worker threads call into it via `block_on` for
// synchronous-from-JS ops; the chat driver runs entire tasks here without
// holding a V8 worker.

use std::sync::OnceLock;
use tokio::runtime::Runtime;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

pub fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("moo-async")
            .build()
            .expect("init tokio runtime")
    })
}
