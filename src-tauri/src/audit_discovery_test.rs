use super::{parse_discovery_diagnostics, parse_discovery_stdout};

#[test]
fn sharing_json_keeps_legacy_defaults_and_local_private_state() {
    let legacy = parse_discovery_stdout(
        r#"[{"id":"local","name":"Canon","status":"online","enabled":true}]"#,
    )
    .unwrap();
    assert!(legacy[0].available_to_odoo);
    let private = parse_discovery_stdout(r#"[{"id":"local","name":"Canon","status":"online","enabled":true,"availableToOdoo":false}]"#).unwrap();
    assert!(!private[0].available_to_odoo);
    assert_eq!(private[0].status, "online");
    assert!(parse_discovery_stdout(r#"[{"id":"local","name":"Canon","status":"online","enabled":true,"availableToOdoo":"false"}]"#).is_err());
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
    let ack = super::decode_printer_visibility_reply(
        br#"{"printerId":"local","availableToOdoo":false}"#,
        "local",
        false,
    )
    .unwrap();
    assert!(!ack.available_to_odoo);
    for payload in [
        br#"{"printerId":"other","availableToOdoo":false}"#.as_slice(),
        br#"{"printerId":"local","availableToOdoo":true}"#.as_slice(),
        br#"{"printerId":"local","availableToOdoo":false,"ok":true}"#.as_slice(),
        br#"{"printerId":"local","availableToOdoo":"false"}"#.as_slice(),
    ] {
        assert!(super::decode_printer_visibility_reply(payload, "local", false).is_err());
    }
}

#[test]
fn local_test_print_preserves_exact_printer_identity_in_cli_args() {
    let executable = std::path::Path::new("fake-agent");
    let config = std::path::Path::new("agent.yaml");
    let root = std::path::Path::new("agent-data");
    for invalid in [
        "",
        "local ",
        " local",
        "-config",
        "local\nother",
        "local\u{85}other",
        "\u{feff}local",
    ] {
        assert!(
            super::build_local_printer_test_command(executable, config, root, invalid).is_err(),
            "local test print silently remapped invalid target {invalid:?}"
        );
    }
    let id = "طابعة-1 (POS)";
    let command =
        super::build_local_printer_test_command(executable, config, root, id).unwrap();
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        vec![
            "printers".to_string(),
            "test".to_string(),
            id.to_string(),
            "-config".to_string(),
            "agent.yaml".to_string(),
        ]
    );
    let long = "é".repeat(129);
    assert!(
        super::build_local_printer_test_command(executable, config, root, &long).is_err()
    );
}

#[test]
fn printer_visibility_preserves_identity_and_allows_printable_virtual_queues() {
    let executable = std::path::Path::new("fake-agent");
    let config = std::path::Path::new("agent.yaml");
    let root = std::path::Path::new("agent-data");
    assert!(
        super::build_printer_visibility_command(executable, config, root, "-config", true).is_err()
    );
    let id = "Microsoft Print to PDF";
    let (validated, command) =
        super::build_printer_visibility_command(executable, config, root, id, true).unwrap();
    assert_eq!(validated, id);
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        vec![
            "printers-share".to_string(),
            "--id".to_string(),
            id.to_string(),
            "--shared".to_string(),
            "true".to_string(),
            "--allow-virtual".to_string(),
            "-config".to_string(),
            "agent.yaml".to_string(),
        ]
    );
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
fn discovery_keeps_printable_virtual_queues_and_rejects_unusable_stubs() {
    let payload = r#"[
        {"id":"physical-1","name":"Office Laser","status":"unknown","enabled":true,"printerType":"physical","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"USB001"}},
        {"id":"virtual-pdf","name":"Microsoft Print to PDF","status":"unknown","enabled":true,"printerType":"virtual","isVirtual":true,"connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"PORTPROMPT:","driver_name":"Microsoft Print to PDF"}},
        {"id":"unusable-fax","name":"Fax","status":"unknown","enabled":true,"printerType":"virtual","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"SHRFAX:","driver_name":"Microsoft Shared Fax Driver"}},
        {"id":"unusable-rdp","name":"HP LaserJet (redirected 2)","status":"unknown","enabled":true,"printerType":"redirected","connectionType":"spooler","protocol":"spooler","capabilities":{"port_name":"TS001"}}
    ]"#;
    let managed = parse_discovery_stdout(payload).unwrap();
    let ids: Vec<&str> = managed.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["physical-1", "virtual-pdf"]);
}
