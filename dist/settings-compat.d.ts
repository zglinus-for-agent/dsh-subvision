import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import type { SettingsSectionHooks } from "@deepseek-ai/dsh-settings";
export declare function installSettingsSectionCompat<Namespace extends string, T>(ctx: Context, ns: Namespace, schema: z<T>, entry: T, hooks: SettingsSectionHooks<T>): void;
//# sourceMappingURL=settings-compat.d.ts.map