use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

/// Menu ids emitted to the frontend as `tray:navigate` payloads. The values
/// MUST be entries of the desktop `Page` union (src/desktop/types.ts):
/// `dashboard | printers | jobs | agents | settings`.
const NAV_GATEWAY: &str = "#dashboard";
const NAV_AGENT: &str = "#agents";
const NAV_PAIR: &str = "#settings";
const NAV_SETTINGS: &str = "#settings";
const TRAY_ID: &str = "main-tray";

#[derive(Clone, Copy)]
struct TrayCopy {
    status_header: &'static str,
    open: &'static str,
    gateway: &'static str,
    agent: &'static str,
    pair: &'static str,
    settings: &'static str,
    restart: &'static str,
    quit: &'static str,
    tooltip: &'static str,
}

fn tray_copy(locale: &str) -> TrayCopy {
    if locale.eq_ignore_ascii_case("ar") {
        TrayCopy {
            // Product identity only: the native tray does not own a fresh
            // Gateway/Agent health observation and must not claim Operational.
            status_header: "Yaseir Print Manager",
            open: "فتح Print Manager",
            gateway: "لوحة الـ Gateway",
            agent: "الـ Agent المحلي والطابعات",
            pair: "ربط Agent...",
            settings: "الإعدادات والتشخيص",
            restart: "إعادة تشغيل خدمة الـ Agent",
            quit: "خروج",
            tooltip: "Yaseir Print Manager — افتح التطبيق لعرض الحالة الحالية للـ Agent والـ Gateway",
        }
    } else {
        TrayCopy {
            status_header: "Yaseir Print Manager",
            open: "Open Manager",
            gateway: "Gateway Dashboard",
            agent: "Local Agent & Printers",
            pair: "Pair Agent...",
            settings: "Settings & Diagnostics",
            restart: "Restart Agent Service",
            quit: "Exit",
            tooltip: "Yaseir Print Manager — open to view current Agent and Gateway status",
        }
    }
}

fn build_menu(app: &tauri::AppHandle, locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let copy = tray_copy(locale);
    let status_header = MenuItem::with_id(
        app,
        "status_header",
        copy.status_header,
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", copy.open, true, None::<&str>)?;
    let gateway = MenuItem::with_id(app, NAV_GATEWAY, copy.gateway, true, None::<&str>)?;
    let agent = MenuItem::with_id(app, NAV_AGENT, copy.agent, true, None::<&str>)?;
    let pair = MenuItem::with_id(app, NAV_PAIR, copy.pair, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, NAV_SETTINGS, copy.settings, true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart_agent", copy.restart, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", copy.quit, true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &status_header,
            &open,
            &gateway,
            &agent,
            &pair,
            &settings,
            &restart,
            &quit,
        ],
    )
}

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Keep native tray text aligned with the Desktop locale. This intentionally
/// updates presentation only; connectivity remains owned by the observed
/// health screens inside the Manager.
#[tauri::command]
pub fn set_tray_locale(locale: String, app: tauri::AppHandle) -> Result<(), String> {
    let normalized = if locale.eq_ignore_ascii_case("ar") { "ar" } else { "en" };
    let copy = tray_copy(normalized);
    let menu = build_menu(&app, normalized).map_err(|e| format!("build tray menu: {e}"))?;
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray is not initialized".to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|e| format!("update tray menu: {e}"))?;
    tray.set_tooltip(Some(copy.tooltip))
        .map_err(|e| format!("update tray tooltip: {e}"))?;
    Ok(())
}

pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let copy = tray_copy("en");
    let menu = build_menu(app, "en")?;

    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => {
            return Err(tauri::Error::from(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "default window icon missing from bundled icons",
            )));
        }
    };

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(copy.tooltip)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => reveal_main_window(app),
            "quit" => app.exit(0),
            "restart_agent" => {
                // The frontend owns the busy/feedback state; it invokes the actual
                // restart command when it receives this event.
                reveal_main_window(app);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("tray:restart_agent", ());
                }
            }
            id if id.starts_with('#') => {
                reveal_main_window(app);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("tray:navigate", id);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
