"""F025/D08 restrict Desktop quota navigation to copyable canonical Gateway billing URL.

Source assertions (native WebView and clipboard NOT_RUN).
"""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def test_desktop_uses_canonical_gateway_origin_instead_of_native_app_route():
    desktop = (ROOT/'src/desktop/components/AddPrinterDialog.tsx').read_text()
    assert 'normalizeGatewayUrl' in desktop
    assert 'copyBillingDestination={{ url: billingUrl }}' in desktop
    assert '`${normalizeGatewayUrl(gatewayUrl)}/billing`' in desktop
    assert 'return null;' in desktop

def test_shared_dialog_web_link_preserved_while_native_requires_explicit_copy_mode():
    shared=(ROOT/'src/components/UpgradeLimitDialog.tsx').read_text()
    assert 'copyBillingDestination?: { url: string | null }' in shared
    assert 'copyBillingDestination ? (' in shared
    # Guarded for insecure contexts (optional chaining); the clipboard write
    # itself plus the read-only manual-select input must both remain.
    assert 'navigator.clipboard' in shared
    assert 'writeText(billingUrl)' in shared
    assert 'href="/billing"' in shared
    assert 'readOnly' in shared and 'value={billingUrl}' in shared
    assert 't("limit.copyBillingLink")' in shared
    assert 't("limit.configureGatewayFirst")' in shared


def test_native_billing_copy_translated_in_both_languages():
    for locale in ('en','ar'):
        contents=(ROOT/f'src/i18n/messages/{locale}.ts').read_text()
        assert '"limit.copyBillingLink":' in contents
        assert '"limit.configureGatewayFirst":' in contents
        assert '"limit.linkCopied":' in contents
