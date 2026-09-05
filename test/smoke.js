import assert from "node:assert";
import config from "../config.js";
import { resolveModel } from "../ai-proxy.js";

assert(config.version, "version must be set");

assert(config.version, "version must be set");
assert(config.proxyPrefix, "proxyPrefix must be set");
assert(config.epoxyPrefix, "epoxyPrefix must be set");
assert(config.baremuxPrefix, "baremuxPrefix must be set");
assert(config.wispPath, "wispPath must be set");
assert(config.scramjetPrefix, "scramjetPrefix must be set");
assert(config.port > 0, "port must be positive");
assert(config.rateLimit, "rateLimit config must exist");
assert(config.wisp, "wisp config must exist");
assert(Array.isArray(config.wisp.dns_servers), "dns_servers must be array");

assert(Array.isArray(config.ai.models) && config.ai.models.length >= 4, "ai models must be listed");
assert(config.ai.models.every((m) => m.id === m.id.toLowerCase()), "ai model ids must be lowercase API ids");
assert(config.ai.baseUrl, "ai baseUrl must be set");
assert(resolveModel("GLM-5.3-Flash") === "glm-5.3-flash", "legacy model ids must map to API ids");
assert(resolveModel("qwen3.8-flash") === "qwen3.8-flash", "canonical model ids must pass through");

console.log(`Smoke test passed - v${config.version}`);
