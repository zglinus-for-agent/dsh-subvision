export function installSettingsSectionCompat(ctx, ns, schema, entry, hooks) {
    let settings;
    try {
        settings = ctx.get("settings");
    }
    catch {
        settings = undefined;
    }
    if (settings !== undefined && typeof settings.installSection === "function") {
        settings.installSection(ctx, ns, schema, entry, hooks);
        return;
    }
    ctx.logger?.warn?.("dsh-subvision: settings service unavailable; settings card disabled");
}
//# sourceMappingURL=settings-compat.js.map