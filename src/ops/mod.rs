use rusty_v8 as v8;

pub mod env;
pub mod facts;
pub mod fs;
pub mod http;
pub mod llm;
pub mod misc;
pub mod proc;
pub mod refs;
pub mod sparql;
pub mod store;

pub fn install_all(scope: &mut v8::PinScope) -> Result<(), String> {
    misc::install(scope)?;
    store::install(scope)?;
    refs::install(scope)?;
    facts::install(scope)?;
    sparql::install(scope)?;
    fs::install(scope)?;
    proc::install(scope)?;
    http::install(scope)?;
    env::install(scope)?;
    Ok(())
}
