use super::parse_discovery_stdout;

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
