import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./config.js";
type Req = IncomingMessage;
type Res = ServerResponse;
interface RegisterOptions {
    kind: "prefix";
    path: string;
    handler: (req: Req, res: Res) => unknown | Promise<unknown>;
}
interface DeviceApiCtx {
    webServer?: {
        register(options: RegisterOptions): () => void;
    };
}
export interface DeviceApiDeps {
    currentConfig: () => PluginConfig;
}
/**
 * Server half of the "识图设备" page: same-origin HTTP API under
 * `/dsh-subvision/v1` exposing the durable per-image vision-subagent
 * registry, configured models for dropdowns, and a per-device "rebuild with
 * another model" action.
 */
export declare function installDevicesApi(ctx: Context & DeviceApiCtx, deps: DeviceApiDeps): void;
export {};
//# sourceMappingURL=vision-devices.d.ts.map