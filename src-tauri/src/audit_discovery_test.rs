use super::{parse_discovery_diagnostics, parse_discovery_stdout};

#[test]
fn discovery_uses_current_cli_result_and_preserves_legacy_empty_output() {
    let (printers, virtual_printers) = parse_discovery_stdout(r#"[{"id":"fresh-scan","name":"Office","status":"unknown","enabled":true,"connectionType":"spooler","protocol":"spooler","capabilities":{"driver_name":"Microsoft enhanced point and print compatibility driver"}}]"#).unwrap();
    assert_eq!(printers.len(), 1);
    assert!(virtual_printers.is_empty());
    assert_eq!(printers[0].id, "fresh-scan");
    assert!(parse_discovery_stdout("[]").unwrap().0.is_empty());
    assert!(parse_discovery_stdout("null").unwrap().0.is_empty());
    assert!(parse_discovery_stdout("Discovery completed: 0 printers").is_err());
    assert!(parse_discovery_stdout(r#"[{"id":"broken"}]"#).is_err());
}


#[test]
fn discovery_diagnostics_keep_actionable_failures_and_drop_routine_logs() {
    let stderr = "2026/10/05 12:00:00 [discovery] starting spooler discovery\n\
2026/10/05 12:00:01 Discovery warning: ipp discovery timed out\n\
2026/10/05 12:00:02 Failed to persist discovery: access denied\n\
2026/10/05 12:00:03 Discovery warning: ipp discovery timed out\n";
    let diagnostics = parse_discovery_diagnostics(stderr);
    assert_eq!(diagnostics, vec![
        "Discovery warning: ipp discovery timed out",
        "Failed to persist discovery: access denied",
    ]);
}

#[test]
fn discovery_exposes_virtual_queues_only_in_local_diagnostics() {
    let payload = r#"[
        {"id":"physical-1","name":"Office Laser","status":"unknown","enabled":true,"printerType":"physical","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"USB001"}},
        {"id":"virtual-1","name":"Microsoft Print to PDF","status":"unknown","enabled":true,"printerType":"virtual","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"PORTPROMPT:","driver_name":"Microsoft Print to PDF"}},
        {"id":"virtual-2","name":"PDF24","status":"unknown","enabled":true,"connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"PORTPROMPT:"}}
    ]"#;
    let (managed, virtual_queues) = parse_discovery_stdout(payload).unwrap();
    assert_eq!(managed.len(), 1);
    assert_eq!(managed[0].id, "physical-1");
    assert_eq!(virtual_queues.len(), 2);
    assert!(virtual_queues.iter().all(|q| super::is_virtual_printer_for_ui(q)));
}
