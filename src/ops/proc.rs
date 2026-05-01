use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusty_v8 as v8;

use crate::runtime::{install_fn, throw};

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_proc_run", op_proc_run)?;
    Ok(())
}

fn op_proc_run(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        throw(
            scope,
            "proc_run requires (cmd, argsJson, [cwd], [stdin], [timeoutMs])",
        );
        return;
    }
    let cmd = args.get(0).to_rust_string_lossy(scope);
    let args_json = args.get(1).to_rust_string_lossy(scope);
    let argv: Vec<String> = match serde_json::from_str(&args_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("proc_run args: {e}"));
            return;
        }
    };
    let cwd = if args.length() > 2 && !args.get(2).is_null_or_undefined() {
        Some(args.get(2).to_rust_string_lossy(scope))
    } else {
        None
    };
    let stdin_text = if args.length() > 3 && !args.get(3).is_null_or_undefined() {
        Some(args.get(3).to_rust_string_lossy(scope))
    } else {
        None
    };
    let timeout_ms: Option<u64> = if args.length() > 4 && args.get(4).is_number() {
        let n = args
            .get(4)
            .to_number(scope)
            .map(|n| n.value())
            .unwrap_or(0.0);
        if n.is_finite() && n > 0.0 {
            Some(n as u64)
        } else {
            None
        }
    } else {
        None
    };

    let started = Instant::now();
    let mut command = Command::new(&cmd);
    command.args(&argv);
    if let Some(c) = &cwd {
        command.current_dir(c);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            throw(scope, &format!("proc_run spawn {cmd}: {e}"));
            return;
        }
    };
    if let Some(text) = stdin_text
        && let Some(mut sin) = child.stdin.take()
    {
        let _ = sin.write_all(text.as_bytes());
    }
    let mut stdout_pipe = match child.stdout.take() {
        Some(p) => p,
        None => {
            throw(scope, "proc_run: stdout not piped");
            return;
        }
    };
    let mut stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None => {
            throw(scope, "proc_run: stderr not piped");
            return;
        }
    };

    let stdout_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let mut timed_out = false;
    let status = match timeout_ms {
        Some(ms) => {
            let deadline = Instant::now() + Duration::from_millis(ms);
            loop {
                match child.try_wait() {
                    Ok(Some(s)) => break s,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            let _ = child.kill();
                            timed_out = true;
                            match child.wait() {
                                Ok(s) => break s,
                                Err(e) => {
                                    throw(scope, &format!("proc_run wait after kill: {e}"));
                                    return;
                                }
                            }
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(e) => {
                        throw(scope, &format!("proc_run try_wait: {e}"));
                        return;
                    }
                }
            }
        }
        None => match child.wait() {
            Ok(s) => s,
            Err(e) => {
                throw(scope, &format!("proc_run wait: {e}"));
                return;
            }
        },
    };

    let stdout_buf = stdout_thread.join().unwrap_or_default();
    let stderr_buf = stderr_thread.join().unwrap_or_default();
    let elapsed_ms = started.elapsed().as_millis() as f64;
    let code = status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&stdout_buf).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_buf).into_owned();

    let obj = v8::Object::new(scope);
    if let Some(k) = v8::String::new(scope, "code") {
        let v = v8::Number::new(scope, code as f64);
        obj.set(scope, k.into(), v.into());
    }
    if let (Some(k), Some(v)) = (
        v8::String::new(scope, "stdout"),
        v8::String::new(scope, &stdout),
    ) {
        obj.set(scope, k.into(), v.into());
    }
    if let (Some(k), Some(v)) = (
        v8::String::new(scope, "stderr"),
        v8::String::new(scope, &stderr),
    ) {
        obj.set(scope, k.into(), v.into());
    }
    if let Some(k) = v8::String::new(scope, "durationMs") {
        let v = v8::Number::new(scope, elapsed_ms);
        obj.set(scope, k.into(), v.into());
    }
    if let Some(k) = v8::String::new(scope, "timedOut") {
        let v = v8::Boolean::new(scope, timed_out);
        obj.set(scope, k.into(), v.into());
    }
    rv.set(obj.into());
}
