import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import type { SettingsSectionHooks } from "@deepseek-ai/dsh-settings";

/**
 * dsh 0.1.5 removed the `installSettingsSection` / `settingsNamespace` exports
 * from `@deepseek-ai/dsh-settings`; the same registration is still reachable
 * through the `settings` service itself. This shim keeps the plugin working on
 * both API generations without branching at every call site (it is the port of
 * the `dist/settings-compat.js` file that was hand-added on 2026-09-12, now
 * part of the TS source so `npm run build` reproduces it).
 */

interface SettingsInstaller<T> {
  installSection(owner: Context, ns: string, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void;
}

export function installSettingsSectionCompat<Namespace extends string, T>(
  ctx: Context,
  ns: Namespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  let settings: SettingsInstaller<T> | undefined;
  try {
    settings = ctx.get("settings") as SettingsInstaller<T> | undefined;
  } catch {
    settings = undefined;
  }
  if (settings !== undefined && typeof settings.installSection === "function") {
    settings.installSection(ctx, ns, schema, entry, hooks);
    return;
  }
  ctx.logger?.warn?.("dsh-subvision: settings service unavailable; settings card disabled");
}
