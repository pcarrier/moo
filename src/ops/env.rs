use rusty_v8 as v8;

use crate::ops::v8util::{required_args, set_return_str};
use crate::runtime::install_fn;

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_env_get", op_env_get)?;
    Ok(())
}

fn op_env_get(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(scope, &args, 1, "env_get requires (name)") {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    match std::env::var(&name) {
        Ok(v) => {
            set_return_str(scope, &mut rv, &v);
        }
        Err(_) => rv.set(v8::null(scope).into()),
    }
}
