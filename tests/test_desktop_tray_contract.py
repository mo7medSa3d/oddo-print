from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_tray_never_claims_unobserved_operational_state():
    tray = read("src-tauri/src/tray.rs")
    assert '"● Yaseir Print Manager • Operational"' not in tray
    assert 'status_header: "Yaseir Print Manager"' in tray
    assert "open to view current Agent and Gateway status" in tray
    assert "افتح التطبيق لعرض الحالة الحالية" in tray


def test_tray_locale_is_runtime_synchronized_from_desktop():
    tray = read("src-tauri/src/tray.rs")
    main_rs = read("src-tauri/src/main.rs")
    ipc = read("src/desktop/lib/ipc.ts")
    desktop = read("src/desktop/main.tsx")

    assert "pub fn set_tray_locale" in tray
    assert "tray.set_menu(Some(menu))" in tray
    assert "tray.set_tooltip(Some(copy.tooltip))" in tray
    assert "tray::set_tray_locale" in main_rs
    assert 'invoke<void>("set_tray_locale", { locale })' in ipc
    assert "void setTrayLocale(locale)" in desktop
    assert "}, [locale]);" in desktop


def test_arabic_tray_copy_preserves_canonical_product_terms():
    tray = read("src-tauri/src/tray.rs")
    assert 'gateway: "لوحة الـ Gateway"' in tray
    assert 'agent: "الـ Agent المحلي والطابعات"' in tray
    assert 'restart: "إعادة تشغيل خدمة الـ Agent"' in tray
