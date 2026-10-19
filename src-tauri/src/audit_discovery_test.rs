use super::{parse_discovery_diagnostics, parse_discovery_stdout};

#[test]
fn sharing_json_keeps_legacy_defaults_and_local_private_state() {
    let legacy = parse_discovery_stdout(
        r#"[{"id":"local","name":"Canon","status":"online","enabled":true}]"#,
    )
    .unwrap();
    assert!(legacy[0].shared_with_gateway);
    let private = parse_discovery_stdout(r#"[{"id":"local","name":"Canon","status":"online","enabled":true,"sharedWithGateway":false}]"#).unwrap();
    assert!(!private[0].shared_with_gateway);
    assert_eq!(private[0].status, "online");
    assert!(parse_discovery_stdout(r#"[{"id":"local","name":"Canon","status":"online","enabled":true,"sharedWithGateway":"false"}]"#).is_err());
}

#[test]
fn sharing_id_and_acknowledgment_are_exact_and_bounded() {
    for id in [
        "",
        " local",
        "local ",
        "-config",
        "local\nqueue",
        "local\u{85}queue",
    ] {
        assert!(
            super::validate_local_printer_id(id).is_err(),
            "accepted {:?}",
            id
        );
    }
    assert!(super::validate_local_printer_id(&"ط".repeat(128)).is_ok());
    assert!(super::validate_local_printer_id(&"ط".repeat(129)).is_err());
    assert_eq!(
        super::validate_local_printer_id("طابعة_محلية").unwrap(),
        "طابعة_محلية"
    );
    let ack = super::decode_printer_sharing_reply(
        br#"{"printerId":"local","sharedWithGateway":false}"#,
        "local",
        false,
    )
    .unwrap();
    assert!(!ack.shared_with_gateway);
    for payload in [
        br#"{"printerId":"other","sharedWithGateway":false}"#.as_slice(),
        br#"{"printerId":"local","sharedWithGateway":true}"#.as_slice(),
        br#"{"printerId":"local","sharedWithGateway":false,"ok":true}"#.as_slice(),
        br#"{"printerId":"local","sharedWithGateway":"false"}"#.as_slice(),
    ] {
        assert!(super::decode_printer_sharing_reply(payload, "local", false).is_err());
    }
}

#[test]
fn discovery_uses_current_cli_result_and_preserves_legacy_empty_output() {
    let printers = parse_discovery_stdout(r#"[{"id":"fresh-scan","name":"Office","status":"unknown","enabled":true,"connectionType":"spooler","protocol":"spooler","capabilities":{"driver_name":"Microsoft enhanced point and print compatibility driver"}}]"#).unwrap();
    assert_eq!(printers.len(), 1);
    assert_eq!(printers[0].id, "fresh-scan");
    assert!(parse_discovery_stdout("[]").unwrap().is_empty());
    assert!(parse_discovery_stdout("null").unwrap().is_empty());
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
    assert_eq!(
        diagnostics,
        vec![
            "Discovery warning: ipp discovery timed out",
            "Failed to persist discovery: access denied",
        ]
    );
}

#[test]
fn discovery_exposes_virtual_queues_only_in_local_diagnostics() {
    let payload = r#"[
        {"id":"physical-1","name":"Office Laser","status":"unknown","enabled":true,"printerType":"physical","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"USB001"}},
        {"id":"virtual-1","name":"Microsoft Print to PDF","status":"unknown","enabled":true,"printerType":"virtual","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"PORTPROMPT:","driver_name":"Microsoft Print to PDF"}},
        {"id":"virtual-2","name":"PDF24","status":"unknown","enabled":true,"connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"PORTPROMPT:"}}
    ]"#;
    let managed = parse_discovery_stdout(payload).unwrap();
    assert_eq!(managed.len(), 1);
    assert_eq!(managed[0].id, "physical-1");
    assert_eq!(managed.len(), 1); // old CLI virtual records are rejected entirely
}
