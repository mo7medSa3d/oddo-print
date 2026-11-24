package printer

// markUserSpoolerConnectionScope preserves current-account connections as
// setup evidence unless Session 0 was positively established. Queue health
// does not prove that a shared service registry may adopt a user's connection.
func markUserSpoolerConnectionScope(infos []DeviceInfo, sessionID uint32, sessionKnown bool) int {
	if sessionKnown && sessionID == 0 {
		return 0
	}
	reason, runtimeScope := "per_user_spooler_connection", "interactive_session_discovery_only"
	if !sessionKnown {
		reason, runtimeScope = "spooler_session_unverified", "unverified_session_discovery_only"
	}
	marked := 0
	for i := range infos {
		scope, _ := infos[i].Capabilities["spooler_scope"].(string)
		if scope != "user_connection" {
			continue
		}
		caps := make(map[string]interface{}, len(infos[i].Capabilities)+3)
		for key, value := range infos[i].Capabilities {
			caps[key] = value
		}
		caps["verification"] = "candidate_only"
		caps["candidate_reason"] = reason
		caps["runtime_scope"] = runtimeScope
		infos[i].Capabilities = caps
		marked++
	}
	return marked
}
