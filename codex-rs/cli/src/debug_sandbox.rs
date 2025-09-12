use std::path::PathBuf;

use codex_common::CliConfigOverrides;
use codex_core::config::Config;
use codex_core::config::ConfigOverrides;
use codex_core::exec_env::create_env;
use codex_core::landlock::spawn_command_under_linux_sandbox;
use codex_core::seatbelt::spawn_command_under_seatbelt;
use codex_core::spawn::StdioPolicy;
use codex_protocol::config_types::SandboxMode;

use crate::LandlockCommand;
use crate::SeatbeltCommand;
use crate::exit_status::handle_exit_status;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicBool;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "macos")]
use tracing::warn;

pub async fn run_command_under_seatbelt(
    command: SeatbeltCommand,
    codex_linux_sandbox_exe: Option<PathBuf>,
) -> anyhow::Result<()> {
    let SeatbeltCommand {
        full_auto,
        log_denials,
        config_overrides,
        command,
    } = command;
    run_command_under_sandbox(
        full_auto,
        command,
        config_overrides,
        codex_linux_sandbox_exe,
        SandboxType::Seatbelt,
        log_denials,
    )
    .await
}

pub async fn run_command_under_landlock(
    command: LandlockCommand,
    codex_linux_sandbox_exe: Option<PathBuf>,
) -> anyhow::Result<()> {
    let LandlockCommand {
        full_auto,
        config_overrides,
        command,
    } = command;
    run_command_under_sandbox(
        full_auto,
        command,
        config_overrides,
        codex_linux_sandbox_exe,
        SandboxType::Landlock,
        false,
    )
    .await
}

enum SandboxType {
    Seatbelt,
    Landlock,
}

type LogStreamHandles = (
    tokio::process::Child,
    tokio::task::JoinHandle<Vec<u8>>,
    tokio::task::JoinHandle<Vec<u8>>,
);

async fn run_command_under_sandbox(
    full_auto: bool,
    command: Vec<String>,
    config_overrides: CliConfigOverrides,
    codex_linux_sandbox_exe: Option<PathBuf>,
    sandbox_type: SandboxType,
    log_denials: bool,
) -> anyhow::Result<()> {
    let sandbox_mode = create_sandbox_mode(full_auto);
    let cwd = std::env::current_dir()?;
    let config = Config::load_with_cli_overrides(
        config_overrides
            .parse_overrides()
            .map_err(anyhow::Error::msg)?,
        ConfigOverrides {
            sandbox_mode: Some(sandbox_mode),
            codex_linux_sandbox_exe,
            ..Default::default()
        },
    )?;
    let stdio_policy = StdioPolicy::Inherit;
    let env = create_env(&config.shell_environment_policy);

    // If requested and using Seatbelt, start a background `log stream` to capture sandbox denials.
    let mut log_child_and_tasks: Option<LogStreamHandles> = None;
    // Track the PIDs of the spawned process and its descendants.
    let mut child_pid_set: Option<Arc<Mutex<HashSet<i32>>>> = None;
    let mut pid_watcher_handle: Option<tokio::task::JoinHandle<()>> = None;
    #[cfg(target_os = "macos")]
    let mut pid_watcher_stop: Option<Arc<AtomicBool>> = None;

    if matches!(sandbox_type, SandboxType::Seatbelt) && log_denials {
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;
        use tokio::process::Command as TokioCommand;

        // Predicate to capture sandbox denial logs.
        let predicate: &str = r#"(((processID == 0) AND (senderImagePath CONTAINS "/Sandbox")) OR (subsystem == "com.apple.sandbox.reporting"))"#;

        let mut log_cmd = TokioCommand::new("log");
        log_cmd
            .arg("stream")
            .arg("--style")
            .arg("ndjson")
            .arg("--predicate")
            .arg(predicate)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        match log_cmd.spawn() {
            Ok(mut child) => match (child.stdout.take(), child.stderr.take()) {
                (Some(mut stdout), Some(mut stderr)) => {
                    let stdout_task = tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let _ = stdout.read_to_end(&mut buf).await;
                        buf
                    });
                    let stderr_task = tokio::spawn(async move {
                        let mut buf = Vec::new();
                        let _ = stderr.read_to_end(&mut buf).await;
                        buf
                    });
                    log_child_and_tasks = Some((child, stdout_task, stderr_task));
                }
                _ => {
                    // Without both pipes we cannot collect log output; drop the process.
                    log_child_and_tasks = None;
                }
            },
            Err(_e) => {
                // If `log` is unavailable, continue without denial logging.
                log_child_and_tasks = None;
            }
        }
    }

    let mut child = match sandbox_type {
        SandboxType::Seatbelt => {
            spawn_command_under_seatbelt(command, &config.sandbox_policy, cwd, stdio_policy, env)
                .await?
        }
        SandboxType::Landlock => {
            #[expect(clippy::expect_used)]
            let codex_linux_sandbox_exe = config
                .codex_linux_sandbox_exe
                .expect("codex-linux-sandbox executable not found");
            spawn_command_under_linux_sandbox(
                codex_linux_sandbox_exe,
                command,
                &config.sandbox_policy,
                cwd,
                stdio_policy,
                env,
            )
            .await?
        }
    };

    #[cfg(target_os = "macos")]
    if matches!(sandbox_type, SandboxType::Seatbelt)
        && log_denials
        && let Some(root_pid_u32) = child.id()
    {
        let root = root_pid_u32 as i32;
        let set = Arc::new(Mutex::new({
            let mut s = HashSet::new();
            s.insert(root);
            s
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let set_clone = Arc::clone(&set);
        let stop_clone = Arc::clone(&stop);
        pid_watcher_handle = Some(tokio::task::spawn_blocking(move || {
            track_descendants(root, set_clone, stop_clone);
        }));
        child_pid_set = Some(set);
        pid_watcher_stop = Some(stop);
    }

    let status = child.wait().await?;

    // Signal the PID watcher to stop and wait for it to exit.
    #[cfg(target_os = "macos")]
    {
        if let Some(stop) = pid_watcher_stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }
    if let Some(handle) = pid_watcher_handle.take() {
        let _ = handle.await;
    }

    // If we captured sandbox denials, stop the logger, gather its output, and print it.
    if let Some((mut log_child, stdout_task, stderr_task)) = log_child_and_tasks {
        // Try to terminate the `log stream` process.
        let _ = log_child.kill().await;
        let stdout_bytes = stdout_task.await.unwrap_or_default();
        let _stderr_bytes = stderr_task.await.unwrap_or_default();

        // Parse ndjson and print only the `eventMessage` field for processes we spawned.
        if !stdout_bytes.is_empty() {
            let s = String::from_utf8_lossy(&stdout_bytes);
            let pid_set = child_pid_set.as_ref();
            let mut seen_denials: HashSet<(String, String)> = HashSet::new();
            let mut ordered_denials: Vec<(String, String)> = Vec::new();
            for line in s.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    let event_msg = json.get("eventMessage").and_then(|v| v.as_str());
                    let mut matched = false;
                    // Prefer the structured processID if present and nonzero.
                    if let Some(pid_val) = json.get("processID").and_then(|v| v.as_i64()) {
                        let pid_i32 = pid_val as i32;
                        if pid_i32 > 0
                            && let Some(set_arc) = pid_set
                            && let Ok(guard) = set_arc.lock()
                            && guard.contains(&pid_i32)
                        {
                            matched = true;
                        }
                    }

                    // Fallback: extract PID from eventMessage like `Sandbox: name(1234) ...`.
                    if !matched
                        && let Some(msg) = event_msg
                        && let Some(pid) = extract_pid_from_message(msg)
                        && let Some(set_arc) = pid_set
                        && let Ok(guard) = set_arc.lock()
                        && guard.contains(&pid)
                    {
                        matched = true;
                    }

                    if matched
                        && let Some(msg) = event_msg
                        && let Some((name, capability)) = parse_denial_details(msg)
                        && seen_denials.insert((name.clone(), capability.clone()))
                    {
                        ordered_denials.push((name, capability));
                    }
                }
            }

            if !ordered_denials.is_empty() {
                eprintln!("\n=== Sandbox denials ===");
                for (name, capability) in ordered_denials {
                    eprintln!("({name}) {capability}");
                }
            }
        }
    }

    handle_exit_status(status);
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn proc_listchildpids(
        ppid: libc::c_int,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn list_child_pids(parent: i32) -> Vec<i32> {
    unsafe {
        let mut capacity: usize = 16;
        loop {
            let mut buf: Vec<i32> = vec![0; capacity];
            let count = proc_listchildpids(
                parent as libc::c_int,
                buf.as_mut_ptr() as *mut libc::c_void,
                (buf.len() * std::mem::size_of::<i32>()) as libc::c_int,
            );
            if count < 0 {
                let err = std::io::Error::last_os_error().raw_os_error();
                if err == Some(libc::ESRCH) {
                    return Vec::new();
                }
                return Vec::new();
            }
            if count == 0 {
                return Vec::new();
            }
            let returned = count as usize;
            if returned < capacity {
                buf.truncate(returned);
                return buf;
            }
            capacity = capacity.saturating_mul(2).max(returned + 16);
        }
    }
}

#[cfg(target_os = "macos")]
fn pid_is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let res = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if res == 0 {
        true
    } else {
        matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        )
    }
}

#[cfg(target_os = "macos")]
enum WatchPidError {
    ProcessGone,
    Other(std::io::Error),
}

#[cfg(target_os = "macos")]
fn watch_pid(kq: libc::c_int, pid: i32) -> Result<(), WatchPidError> {
    if pid <= 0 {
        return Err(WatchPidError::ProcessGone);
    }

    let kev = libc::kevent {
        ident: pid as libc::uintptr_t,
        filter: libc::EVFILT_PROC,
        flags: (libc::EV_ADD | libc::EV_CLEAR),
        fflags: (libc::NOTE_FORK | libc::NOTE_EXEC | libc::NOTE_EXIT),
        data: 0,
        udata: std::ptr::null_mut(),
    };

    let res = unsafe { libc::kevent(kq, &kev, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
    if res < 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            Err(WatchPidError::ProcessGone)
        } else {
            Err(WatchPidError::Other(err))
        }
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn ensure_children(
    kq: libc::c_int,
    parent: i32,
    seen: &mut HashSet<i32>,
    active: &mut HashSet<i32>,
) {
    for child_pid in list_child_pids(parent) {
        if child_pid <= 0 {
            continue;
        }

        if seen.insert(child_pid) {
            add_pid_watch(kq, child_pid, seen, active);
        } else if !active.contains(&child_pid) && active.insert(child_pid) {
            match watch_pid(kq, child_pid) {
                Ok(()) => ensure_children(kq, child_pid, seen, active),
                Err(WatchPidError::ProcessGone) => {
                    active.remove(&child_pid);
                }
                Err(WatchPidError::Other(err)) => {
                    warn!("failed to watch child pid {child_pid}: {err}");
                    active.remove(&child_pid);
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn add_pid_watch(kq: libc::c_int, pid: i32, seen: &mut HashSet<i32>, active: &mut HashSet<i32>) {
    if pid <= 0 {
        return;
    }

    let newly_seen = seen.insert(pid);
    if active.insert(pid) {
        match watch_pid(kq, pid) {
            Ok(()) => {}
            Err(WatchPidError::ProcessGone) => {
                active.remove(&pid);
                return;
            }
            Err(WatchPidError::Other(err)) => {
                warn!("failed to watch pid {pid}: {err}");
                active.remove(&pid);
                return;
            }
        }
    }

    if newly_seen {
        ensure_children(kq, pid, seen, active);
    }
}

#[cfg(target_os = "macos")]
fn track_descendants(root_pid: i32, pid_set: Arc<Mutex<HashSet<i32>>>, stop: Arc<AtomicBool>) {
    use std::thread;
    use std::time::Duration;

    let kq = unsafe { libc::kqueue() };
    if kq < 0 {
        if let Ok(mut guard) = pid_set.lock() {
            guard.insert(root_pid);
        }
        return;
    }

    let mut seen: HashSet<i32> = HashSet::new();
    let mut active: HashSet<i32> = HashSet::new();

    add_pid_watch(kq, root_pid, &mut seen, &mut active);

    const EVENTS_CAP: usize = 32;
    let mut events: [libc::kevent; EVENTS_CAP] =
        unsafe { std::mem::MaybeUninit::zeroed().assume_init() };

    // Run until we're signaled to stop. We don't require all descendants to exit;
    // when the root process finishes, we stop tracking promptly to avoid hangs.
    while !stop.load(Ordering::Relaxed) {
        if active.is_empty() {
            if !pid_is_alive(root_pid) {
                break;
            }
            add_pid_watch(kq, root_pid, &mut seen, &mut active);
            if active.is_empty() {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
        }

        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 50_000_000,
        };

        let nev = unsafe {
            libc::kevent(
                kq,
                std::ptr::null::<libc::kevent>(),
                0,
                events.as_mut_ptr(),
                EVENTS_CAP as libc::c_int,
                &timeout,
            )
        };

        if nev < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }

        if nev == 0 {
            continue;
        }

        for ev in events.iter().take(nev as usize) {
            let pid = ev.ident as i32;

            if (ev.flags & libc::EV_ERROR) != 0 {
                if ev.data == libc::ESRCH as isize {
                    active.remove(&pid);
                }
                continue;
            }

            if (ev.fflags & libc::NOTE_FORK) != 0 {
                ensure_children(kq, pid, &mut seen, &mut active);
            }

            if (ev.fflags & libc::NOTE_EXIT) != 0 {
                active.remove(&pid);
            }
        }
    }

    let _ = unsafe { libc::close(kq) };

    if let Ok(mut guard) = pid_set.lock() {
        guard.extend(seen);
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(unused_variables)]
fn track_descendants(
    _root_pid: i32,
    _pid_set: Arc<Mutex<HashSet<i32>>>,
    _stop: Arc<std::sync::atomic::AtomicBool>,
) {
}

fn extract_pid_from_message(msg: &str) -> Option<i32> {
    // Look for first number inside parentheses: e.g., "... name(1234) ..."
    let mut start = None;
    for (i, ch) in msg.char_indices() {
        if ch == '(' {
            start = Some(i + 1);
        } else if ch == ')'
            && let Some(s) = start.take()
        {
            let inside = &msg[s..i];
            if !inside.is_empty()
                && inside.chars().all(|c| c.is_ascii_digit())
                && let Ok(n) = inside.parse::<i32>()
            {
                return Some(n);
            }
        }
    }
    None
}

fn parse_denial_details(msg: &str) -> Option<(String, String)> {
    let after_prefix = msg.strip_prefix("Sandbox:")?.trim_start();
    let open_paren = after_prefix.find('(')?;
    let close_paren_rel = after_prefix[open_paren..].find(')')?;
    let close_paren = open_paren + close_paren_rel;
    let name = after_prefix[..open_paren].trim();
    if name.is_empty() {
        return None;
    }

    let after_paren = after_prefix[close_paren + 1..].trim_start();
    let deny_idx = after_paren.find("deny(")?;
    let after_deny = &after_paren[deny_idx..];
    let deny_close_rel = after_deny.find(')')?;
    let capability = after_deny[deny_close_rel + 1..].trim_start();
    if capability.is_empty() {
        return None;
    }

    Some((name.to_string(), capability.to_string()))
}

pub fn create_sandbox_mode(full_auto: bool) -> SandboxMode {
    if full_auto {
        SandboxMode::WorkspaceWrite
    } else {
        SandboxMode::ReadOnly
    }
}
