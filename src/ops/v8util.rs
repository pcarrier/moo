use rusty_v8 as v8;

use crate::runtime::throw;

pub fn required_args(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    min: i32,
    message: &str,
) -> bool {
    if args.length() >= min {
        return true;
    }
    throw(scope, message);
    false
}

pub fn set_return_str(scope: &mut v8::PinScope, rv: &mut v8::ReturnValue, value: &str) {
    if let Some(s) = v8::String::new(scope, value) {
        rv.set(s.into());
    }
}

pub fn array_from_strings<'s, 'i>(
    scope: &mut v8::PinScope<'s, 'i>,
    values: &[String],
) -> v8::Local<'s, v8::Array> {
    let arr = v8::Array::new(scope, values.len() as i32);
    for (i, value) in values.iter().enumerate() {
        if let Some(s) = v8::String::new(scope, value) {
            arr.set_index(scope, i as u32, s.into());
        }
    }
    arr
}

pub fn set_object_str(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    key: &str,
    value: &str,
) {
    if let (Some(k), Some(v)) = (v8::String::new(scope, key), v8::String::new(scope, value)) {
        obj.set(scope, k.into(), v.into());
    }
}

pub fn set_object_value(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    key: &str,
    value: v8::Local<v8::Value>,
) {
    if let Some(k) = v8::String::new(scope, key) {
        obj.set(scope, k.into(), value);
    }
}
