/** @odoo-module */

import { Component, onMounted, onWillUnmount, useState } from "@odoo/owl";
import { browser } from "@web/core/browser/browser";
import { Dropdown } from "@web/core/dropdown/dropdown";
import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { useService } from "@web/core/utils/hooks";
import { withGatewayDeadline } from "../js/async_control";

const LANGUAGE_FAMILIES = [
    { prefix: "en", label: "English" },
    { prefix: "ar", label: "العربية" },
];

export class PrintGatewayLanguageSwitcher extends Component {
    static template = "print_gateway.LanguageSwitcher";
    static components = { Dropdown, DropdownItem };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.label = _t("Language");
        this.alive = true;
        this.loadGeneration = 0;
        this.state = useState({ languages: [] });

        onMounted(() => this.loadLanguages());
        onWillUnmount(() => {
            this.alive = false;
            this.loadGeneration += 1;
        });
    }


    async loadLanguages() {
        const generation = ++this.loadGeneration;
        try {
            const installed = await withGatewayDeadline(
                () => this.orm.searchRead(
                    "res.lang",
                    [["active", "=", true]],
                    ["code", "name"],
                ),
                15000,
                _t("Loading languages timed out."),
            );
            if (!this.alive || generation !== this.loadGeneration) return;

            const byFamily = new Map();
            for (const family of LANGUAGE_FAMILIES) {
                const matching = installed
                    .filter((lang) => typeof lang.code === "string" && lang.code.toLowerCase().startsWith(family.prefix))
                    .sort((a, b) => Number(b.code === user.lang) - Number(a.code === user.lang));

                if (matching.length) {
                    byFamily.set(family.prefix, { code: matching[0].code, label: family.label });
                }
            }

            if (!byFamily.size && user.lang) {
                const current = installed.find((lang) => lang.code === user.lang);
                if (current) {
                    byFamily.set("current", { code: current.code, label: current.name || current.code });
                }
            }
            this.state.languages = Array.from(byFamily.values());
        } catch {
            if (!this.alive || generation !== this.loadGeneration) return;
            this.state.languages = user.lang ? [{ code: user.lang, label: user.lang }] : [];
        }
    }

    get languages() {
        return this.state.languages;
    }

    get currentCode() {
        return user.lang || "en_US";
    }

    get currentLabel() {
        const currentFamily = this.currentCode.toLowerCase().startsWith("ar") ? "ar" : "en";
        return LANGUAGE_FAMILIES.find((family) => family.prefix === currentFamily)?.label || this.currentCode;
    }

    async selectLanguage(code) {
        if (!code || code === this.currentCode) {
            return;
        }

        try {
            await withGatewayDeadline(
                () => this.orm.write("res.users", [user.userId], { lang: code }),
                15000,
                _t("Changing language timed out. Reload the page before trying again."),
            );
            if (!this.alive) return;
            user.updateContext({ lang: code });
            browser.location.reload();
        } catch {
            this.notification.add(
                _t("Could not change language. Make sure the language is installed."),
                { type: "danger" },
            );
        }
    }
}

registry.category("systray").add(
    "print_gateway.language_switcher",
    { Component: PrintGatewayLanguageSwitcher },
    { sequence: 5 },
);
