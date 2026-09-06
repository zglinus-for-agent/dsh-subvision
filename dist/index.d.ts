import type { Context } from "@deepseek-ai/cordis";
import { type PluginConfig } from "./config.js";
export { Config, normalizeConfig } from "./config.js";
export { VisionRegistry } from "./vision-registry.js";
export type { PluginConfig, VisionModel } from "./config.js";
export declare const name = "dsh-subvision";
export declare const inject: string[];
export declare function apply(ctx: Context, config: PluginConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: import("@deepseek-ai/schemastery").default<PluginConfig>;
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map