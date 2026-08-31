// Full regression: run all suites in order; fail if any suite fails.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  "iter1-baseline.test.mjs",
  "iter2-proxy-security.test.mjs",
  "iter3-settings-games.test.mjs",
  "iter4-admin-pwa-reg.test.mjs",
  "iter5-responsive-a11y.test.mjs",
];

let totalFailed = 0;
for (const s of suites) {
  console.log(`\n########## ${s} ##########`);
  const r = spawnSync("node", [path.join(__dirname, s)], {
    stdio: "inherit",
    shell: false,
  });
  if (r.status !== 0) {
    totalFailed++;
    console.log(`### ${s} EXITED ${r.status}`);
  }
}
console.log(`\n########## REGRESSION SUMMARY: ${suites.length - totalFailed}/${suites.length} suites clean ##########`);
process.exit(totalFailed > 0 ? 1 : 0);
