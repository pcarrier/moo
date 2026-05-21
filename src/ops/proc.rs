use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusty_v8 as v8;

use crate::ops::v8util::{required_args, set_object_str, set_object_value};
use crate::runtime::{current_cancel_token, install_fn, throw};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub fn install(scope: &mut v8::PinScope) -> Result<(), String> {
    install_fn(scope, "__op_proc_run", op_proc_run)?;
    Ok(())
}

fn op_proc_run(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if !required_args(
        scope,
        &args,
        1,
        "proc_run requires (cmdJson, [cwd], [stdin], [timeoutMs], [envJson], [maxOutputBytes])",
    ) {
        return;
    }
    let cmd_json = args.get(0).to_rust_string_lossy(scope);
    let cmd_argv: Vec<String> = match serde_json::from_str(&cmd_json) {
        Ok(v) => v,
        Err(e) => {
            throw(scope, &format!("proc_run cmd: {e}"));
            return;
        }
    };
    if cmd_argv.is_empty() {
        throw(scope, "proc_run cmd must not be empty");
        return;
    }
    let program = &cmd_argv[0];
    let program_args = &cmd_argv[1..];
    let cwd = if args.length() > 1 && !args.get(1).is_null_or_undefined() {
        Some(args.get(1).to_rust_string_lossy(scope))
    } else {
        None
    };
    let stdin_text = if args.length() > 2 && !args.get(2).is_null_or_undefined() {
        Some(args.get(2).to_rust_string_lossy(scope))
    } else {
        None
    };
    let timeout_ms: Option<u64> = if args.length() > 3 && args.get(3).is_number() {
        let n = args
            .get(3)
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
    let env_overrides: Option<HashMap<String, Option<String>>> =
        if args.length() > 4 && !args.get(4).is_null_or_undefined() {
            let env_json = args.get(4).to_rust_string_lossy(scope);
            match serde_json::from_str(&env_json) {
                Ok(v) => Some(v),
                Err(e) => {
                    throw(scope, &format!("proc_run env: {e}"));
                    return;
                }
            }
        } else {
            None
        };
    let max_output_bytes: Option<usize> = if args.length() > 5 && args.get(5).is_number() {
        let n = args
            .get(5)
            .to_number(scope)
            .map(|n| n.value())
            .unwrap_or(0.0);
        if n.is_finite() && n > 0.0 {
            Some(n as usize)
        } else {
            None
        }
    } else {
        None
    };

    let started = Instant::now();
    let mut command = Command::new(program);
    command.args(program_args);
    configure_process_group(&mut command);
    if let Some(c) = &cwd {
        command.current_dir(c);
    }
    if let Some(envs) = &env_overrides {
        for (key, value) in envs {
            match value {
                Some(v) => {
                    command.env(key, v);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
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
            throw(scope, &format!("proc_run spawn {program}: {e}"));
            return;
        }
    };
    if let Some(text) = stdin_text
        && let Some(mut sin) = child.stdin.take()
    {
        let _ = sin.write_all(text.as_bytes());
    }
    let stdout_pipe = match child.stdout.take() {
        Some(p) => p,
        None => {
            throw(scope, "proc_run: stdout not piped");
            return;
        }
    };
    let stderr_pipe = match child.stderr.take() {
        Some(p) => p,
        None => {
            throw(scope, "proc_run: stderr not piped");
            return;
        }
    };

    let stdout_limit = max_output_bytes;
    let stderr_limit = max_output_bytes;
    let stdout_thread = thread::spawn(move || read_limited(stdout_pipe, stdout_limit));
    let stderr_thread = thread::spawn(move || read_limited(stderr_pipe, stderr_limit));

    let cancel_token = current_cancel_token();
    let mut timed_out = false;
    let mut cancelled = false;
    let status = match timeout_ms {
        Some(ms) => {
            let deadline = Instant::now() + Duration::from_millis(ms);
            loop {
                match child.try_wait() {
                    Ok(Some(s)) => break s,
                    Ok(None) => {
                        if cancel_token
                            .as_ref()
                            .is_some_and(|token| token.load(std::sync::atomic::Ordering::SeqCst))
                        {
                            terminate_process_tree(&mut child);
                            cancelled = true;
                            match child.wait() {
                                Ok(s) => break s,
                                Err(e) => {
                                    throw(scope, &format!("proc_run wait after cancel: {e}"));
                                    return;
                                }
                            }
                        }
                        if Instant::now() >= deadline {
                            terminate_process_tree(&mut child);
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
        None => loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {
                    if cancel_token
                        .as_ref()
                        .is_some_and(|token| token.load(std::sync::atomic::Ordering::SeqCst))
                    {
                        terminate_process_tree(&mut child);
                        cancelled = true;
                        match child.wait() {
                            Ok(s) => break s,
                            Err(e) => {
                                throw(scope, &format!("proc_run wait after cancel: {e}"));
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
        },
    };

    let stdout_capture = stdout_thread.join().unwrap_or_default();
    let stderr_capture = stderr_thread.join().unwrap_or_default();
    let elapsed_ns = started.elapsed().as_nanos() as f64;
    let code = status.code().unwrap_or(-1);
    let stdout_truncated = stdout_capture.truncated;
    let stderr_truncated = stderr_capture.truncated;
    let stdout = String::from_utf8_lossy(&stdout_capture.bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_capture.bytes).into_owned();

    let obj = v8::Object::new(scope);
    let code_value = v8::Number::new(scope, code as f64);
    set_object_value(scope, obj, "code", code_value.into());
    set_object_str(scope, obj, "stdout", &stdout);
    set_object_str(scope, obj, "stderr", &stderr);
    let elapsed_value = v8::Number::new(scope, elapsed_ns);
    set_object_value(scope, obj, "durationNs", elapsed_value.into());
    let timed_out_value = v8::Boolean::new(scope, timed_out);
    set_object_value(scope, obj, "timedOut", timed_out_value.into());
    if cancelled {
        set_object_str(scope, obj, "stderr", "proc_run cancelled");
    }
    let stdout_truncated_value = v8::Boolean::new(scope, stdout_truncated);
    set_object_value(scope, obj, "stdoutTruncated", stdout_truncated_value.into());
    let stderr_truncated_value = v8::Boolean::new(scope, stderr_truncated);
    set_object_value(scope, obj, "stderrTruncated", stderr_truncated_value.into());
    rv.set(obj.into());
}

#[derive(Default)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_limited(mut pipe: impl Read, limit: Option<usize>) -> CapturedOutput {
    let mut captured = CapturedOutput::default();
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if let Some(max) = limit {
            let remaining = max.saturating_sub(captured.bytes.len());
            if remaining > 0 {
                captured
                    .bytes
                    .extend_from_slice(&chunk[..read.min(remaining)]);
            }
            if read > remaining {
                captured.truncated = true;
            }
        } else {
            captured.bytes.extend_from_slice(&chunk[..read]);
        }
    }
    captured
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            unsafe {
                let _ = libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::read_limited;
    use std::io::Cursor;

    #[cfg(unix)]
    use super::{configure_process_group, terminate_process_tree};
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn read_limited_bounds_output_while_reading() {
        let captured = read_limited(Cursor::new(vec![b'x'; 64]), Some(10));
        assert_eq!(captured.bytes, vec![b'x'; 10]);
        assert!(captured.truncated);
    }

    #[test]
    fn read_limited_reports_complete_output() {
        let captured = read_limited(Cursor::new(b"hello".to_vec()), Some(10));
        assert_eq!(captured.bytes, b"hello");
        assert!(!captured.truncated);
    }

    #[test]
    fn read_limited_unbounded_reads_all_output() {
        let captured = read_limited(Cursor::new(vec![b'y'; 32]), None);
        assert_eq!(captured.bytes, vec![b'y'; 32]);
        assert!(!captured.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_process_tree_kills_descendants() {
        let marker = std::env::temp_dir().join(format!(
            "moo-proc-tree-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_file(&marker);

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("(sleep 0.4; echo alive > \"$1\") & wait")
            .arg("sh")
            .arg(&marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);

        let mut child = command.spawn().expect("spawn shell with descendant");
        std::thread::sleep(Duration::from_millis(50));
        terminate_process_tree(&mut child);
        let _ = child.wait();
        std::thread::sleep(Duration::from_millis(700));

        assert!(
            !marker.exists(),
            "descendant survived process-tree termination and wrote {}",
            marker.display()
        );
        let _ = fs::remove_file(&marker);
    }
}
