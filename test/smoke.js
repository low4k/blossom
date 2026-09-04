import assert from "node:assert";
import config from "../config.js";

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
assert(config.ai.baseUrl, "ai baseUrl must be set");

console.log(`Smoke test passed - v${config.version}`);
