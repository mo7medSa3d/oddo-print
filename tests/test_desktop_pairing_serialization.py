"""Execute actual Rust pairing/control orchestration with OS/CLI boundaries faked.

No Tauri/Windows/HTTP process is run. Barriers hold the CLI just before its
configuration commit while a real concurrent control operation tries to start.
"""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def function(source, marker):
    start = source.index(marker)
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        if source[end] == '{':
            depth += 1
        elif source[end] == '}':
            depth -= 1
        end += 1
    return source[start:end]


def test_pairing_and_control_share_one_transaction(tmp_path):
    commands = (ROOT / 'src-tauri/src/commands.rs').read_text()
    agent = (ROOT / 'src-tauri/src/agent.rs').read_text()
    pairing = function(commands, 'fn is_valid_code(') + '\n' + function(commands, 'fn run_pairing(')
    if 'fn run_pairing_inner(' in commands:
        pairing += '\n' + function(commands, 'fn run_pairing_inner(')
    control = function(agent, 'pub fn start(') + '\n' + function(agent, 'pub fn restart(')
    for marker in ['pub(crate) fn with_control<', 'pub(crate) fn restart_inner(']:
        if marker in agent:
            control += '\n' + function(agent, marker)
    source = r'''
use std::process::Command;
use std::sync::{Mutex, Condvar};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
mod tauri { #[derive(Clone)] pub struct AppHandle; }
mod paths {
    pub fn agent_config_path() -> std::path::PathBuf { "fixture-config.yaml".into() }
    pub fn agent_data_root() -> std::path::PathBuf { "fixture-root".into() }
    pub fn ensure_agent_data_root() -> Result<std::path::PathBuf, String> { Ok(agent_data_root()) }
}
mod logging { pub fn info(_: &str) {} pub fn error(_: &str) {} }
static STATE: Mutex<(bool, bool)> = Mutex::new((false, false));
static WAKE: Condvar = Condvar::new();
static RUNNING: AtomicBool = AtomicBool::new(false);
static CONFIG_ID: AtomicUsize = AtomicUsize::new(1);
static RUNTIME_ID: AtomicUsize = AtomicUsize::new(0);
static FAIL_PAIR: AtomicBool = AtomicBool::new(false);
static FAIL_START: AtomicBool = AtomicBool::new(false);
mod agent {
    use super::*;
''' + agent[agent.index('static AGENT_CONTROL:'):agent.index(';', agent.index('static AGENT_CONTROL:')) + 1] + r'''
    pub fn cli_path(_: &tauri::AppHandle) -> Result<std::path::PathBuf, String> { Ok("fixture-cli".into()) }
    fn ensure_service_installed(_: &tauri::AppHandle) -> Result<(), String> { Ok(()) }
    fn start_inner(_: &tauri::AppHandle) -> Result<(), String> {
        if FAIL_START.load(Ordering::SeqCst) { return Err("fixture start failed".into()); }
        RUNTIME_ID.store(CONFIG_ID.load(Ordering::SeqCst), Ordering::SeqCst);
        RUNNING.store(true, Ordering::SeqCst); Ok(())
    }
    fn stop_inner(_: &tauri::AppHandle) -> Result<(), String> { RUNNING.store(false, Ordering::SeqCst); Ok(()) }
    pub fn status(_: &tauri::AppHandle) -> (bool, bool, String) { (RUNNING.load(Ordering::SeqCst), false, String::new()) }
    pub struct FixtureStatus(bool);
    impl FixtureStatus { pub fn success(&self) -> bool { self.0 } }
    pub struct FixtureOutput { pub status: FixtureStatus, pub stdout: Vec<u8>, pub stderr: Vec<u8> }
    pub fn run_bounded_command(_: Command, _: std::time::Duration, _: usize, _: usize) -> Result<FixtureOutput, String> {
        let mut state = STATE.lock().unwrap(); state.0 = true; WAKE.notify_all();
        while !state.1 { state = WAKE.wait(state).unwrap(); }
        let success = !FAIL_PAIR.load(Ordering::SeqCst);
        if success { CONFIG_ID.store(2, Ordering::SeqCst); }
        Ok(FixtureOutput { status: FixtureStatus(success), stdout: b"paired fixture".to_vec(), stderr: if success { vec![] } else { b"fixture pairing failed".to_vec() } })
    }
''' + control + '\n}\n' + pairing + r'''
fn reset(running: bool) {
    *STATE.lock().unwrap() = (false, false);
    RUNNING.store(running, Ordering::SeqCst); CONFIG_ID.store(1, Ordering::SeqCst);
    RUNTIME_ID.store(if running { 1 } else { 0 }, Ordering::SeqCst);
    FAIL_PAIR.store(false, Ordering::SeqCst); FAIL_START.store(false, Ordering::SeqCst);
}
fn release_pairing() { STATE.lock().unwrap().1 = true; WAKE.notify_all(); }
#[test]
fn pairing_then_concurrent_start_activates_the_saved_identity() {
    reset(false);
    let pairing = std::thread::spawn(|| run_pairing(tauri::AppHandle, "ABCD23", "https://fixture.invalid"));
    let mut state = STATE.lock().unwrap();
    while !state.0 { state = WAKE.wait(state).unwrap(); }
    drop(state);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let start = std::thread::spawn(move || {
        entered_tx.send(()).unwrap();
        let result = agent::start(&tauri::AppHandle);
        done_tx.send(()).unwrap(); result
    });
    entered_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    // Baseline completes start using identity1 while the CLI is held. A fixed
    // transaction keeps start waiting until identity2 is durable.
    let premature_start = done_rx.recv_timeout(std::time::Duration::from_millis(200)).is_ok();
    release_pairing();
    pairing.join().unwrap().unwrap(); start.join().unwrap().unwrap();
    assert_eq!(RUNTIME_ID.load(Ordering::SeqCst), CONFIG_ID.load(Ordering::SeqCst), "running Agent kept stale identity after pairing (start overlapped={premature_start})");
}
#[test]
fn running_agent_is_restarted_and_pair_failure_keeps_original_identity() {
    reset(true); release_pairing();
    assert!(run_pairing(tauri::AppHandle, "ABCD23", "https://fixture.invalid").unwrap().contains("restarted"));
    assert_eq!(RUNTIME_ID.load(Ordering::SeqCst), 2);
    reset(true); FAIL_PAIR.store(true, Ordering::SeqCst); release_pairing();
    assert_eq!(run_pairing(tauri::AppHandle, "ABCD23", "https://fixture.invalid").unwrap_err(), "fixture pairing failed");
    assert_eq!(CONFIG_ID.load(Ordering::SeqCst), 1); assert_eq!(RUNTIME_ID.load(Ordering::SeqCst), 1);
}
#[test]
fn stopped_agent_stays_stopped_after_pairing_and_failed_pairing() {
    reset(false); release_pairing();
    let message = run_pairing(tauri::AppHandle, "ABCD23", "https://fixture.invalid").unwrap();
    assert!(message.contains("saved; start the agent"));
    assert!(!RUNNING.load(Ordering::SeqCst)); assert_eq!(CONFIG_ID.load(Ordering::SeqCst), 2);
    reset(false); FAIL_PAIR.store(true, Ordering::SeqCst); release_pairing();
    assert!(run_pairing(tauri::AppHandle, "ABCD23", "https://fixture.invalid").is_err());
    assert!(!RUNNING.load(Ordering::SeqCst)); assert_eq!(CONFIG_ID.load(Ordering::SeqCst), 1);
}
#[test]
fn pairing_validation_keeps_invalid_codes_out() {
    assert!(is_valid_code("ABCD23"));
    for code in ["", "ABC123", "-config", "ABCDEF7", "ABCI23", "ABCO23"] {
        assert!(!is_valid_code(code), "accepted invalid code {code}");
    }
}
#[test]
fn activation_failure_reports_saved_pairing() {
    reset(true); FAIL_START.store(true, Ordering::SeqCst); release_pairing();
    let error = run_pairing(tauri::AppHandle, "ABCD23", "https://fixture.invalid").unwrap_err();
    assert!(error.contains("pairing saved")); assert!(error.contains("fixture start failed"));
    assert_eq!(CONFIG_ID.load(Ordering::SeqCst), 2); assert!(!RUNNING.load(Ordering::SeqCst));
}
'''
    harness = tmp_path / 'pairing.rs'
    harness.write_text(source)
    executable = tmp_path / ('pairing.exe' if os.name == 'nt' else 'pairing')
    build = subprocess.run(['rustc', '--edition=2024', '--test', str(harness), '-o', str(executable)], capture_output=True, text=True, timeout=60)
    assert build.returncode == 0, build.stderr
    result = subprocess.run([str(executable), '--test-threads=1', '--nocapture'], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr
