import fs from "node:fs";
import path from "node:path";

const TEAM = "adadadss-team";
const PROJECT = "asdsa";
const SERVICE = "blossom";
const VOLUME = "blossom-data";
const API = "https://api.northflank.com/v1";

function loadToken() {
  const p = path.resolve("northflank_token.txt");
  const t = fs.readFileSync(p, "utf8").trim();
  if (!t.startsWith("nf-")) throw new Error("northflank_token.txt is missing or invalid");
  return t;
}

function loadEnvFile(name, into) {
  try {
    for (const line of fs.readFileSync(name, "utf8").split("\n")) {
      if (!line || line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (into[m[1]] === undefined) into[m[1]] = val;
    }
  } catch {}
}

async function nf(token, method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 2000) };
}

function redact(s) {
  return String(s || "")
    .replace(/nf-eyJ[A-Za-z0-9._-]+/g, "[token]")
    .replace(/sk-[A-Za-z0-9]+/gi, "[redacted]");
}

const cmd = process.argv[2] || "probe";
const token = loadToken();

if (cmd === "probe") {
  const hits = [
    `/teams/${TEAM}/projects/${PROJECT}`,
    `/projects/${PROJECT}`,
    `/teams/${TEAM}/projects/${PROJECT}/services`,
    `/teams/${TEAM}/projects/${PROJECT}/volumes`,
  ];
  for (const p of hits) {
    const r = await nf(token, "GET", p);
    console.log(r.status, p, redact(JSON.stringify(r.json || r.text)).slice(0, 800));
  }
  process.exit(0);
}

if (cmd === "create-volume") {
  const r = await nf(token, "POST", `/teams/${TEAM}/projects/${PROJECT}/volumes`, {
    name: VOLUME,
    mounts: [{ containerMountPath: "/app/data" }],
    spec: { storageClassName: "ssd", storageSize: 1024 },
  });
  console.log(r.status, redact(JSON.stringify(r.json || r.text)).slice(0, 1200));
  process.exit(r.status < 300 || r.status === 409 ? 0 : 1);
}

if (cmd === "create-service") {
  const r = await nf(token, "POST", `/teams/${TEAM}/projects/${PROJECT}/services/combined`, {
    name: SERVICE,
    description: "Blossom proxy",
    billing: { deploymentPlan: "nf-compute-20" },
    disabledCI: false,
    vcsData: {
      projectUrl: "https://github.com/low4k/blossom",
      projectType: "github",
      projectBranch: "main",
    },
    buildSettings: {
      dockerfile: {
        buildEngine: "buildkit",
        dockerFilePath: "/Dockerfile",
        dockerWorkDir: "/",
      },
    },
    deployment: {
      instances: 1,
      docker: { configType: "default" },
      storage: { ephemeralStorage: { storageSize: 1024 } },
    },
    ports: [
      {
        name: "http",
        internalPort: 8080,
        public: true,
        protocol: "HTTP",
      },
    ],
    runtimeEnvironment: {
      NODE_ENV: "production",
      PORT: "8080",
      DB_PATH: "/app/data/blossom.db",
      PROXY_PREFIX: "/cdn/m/",
      EPOXY_PREFIX: "/cdn/n/",
      BAREMUX_PREFIX: "/cdn/w/",
      WISP_PATH: "/sock/",
      SCRAMJET_PREFIX: "/~/",
    },
    healthChecks: [
      {
        protocol: "HTTP",
        type: "readinessProbe",
        path: "/health",
        port: 8080,
        initialDelaySeconds: 15,
        periodSeconds: 20,
        timeoutSeconds: 3,
        failureThreshold: 5,
        successThreshold: 1,
      },
    ],
    createOptions: {
      volumesToAttach: [VOLUME],
    },
  });
  console.log(r.status, redact(JSON.stringify(r.json || r.text)).slice(0, 2000));
  process.exit(r.status < 300 || r.status === 409 ? 0 : 1);
}

if (cmd === "secrets") {
  const env = {};
  loadEnvFile(".env.local", env);
  loadEnvFile(".env", env);
  try {
    const pass = fs.readFileSync("fly_dev_pass.txt", "utf8").trim();
    if (pass && !env.DEV_PASS) env.DEV_PASS = pass;
  } catch {}
  const keys = [
    "DEV_EMAIL", "DEV_PASS", "BAI_API_KEY", "BAI_BASE_URL",
    "DONATE_CASHAPP_URL", "DONATE_PAYPAL_URL", "INVITE_CODE", "REGISTRATION",
  ];
  const variables = {};
  for (const k of keys) {
    if (env[k]) variables[k] = env[k];
  }
  console.log("secret_keys", Object.keys(variables).join(",") || "(none)");
  const r = await nf(token, "POST", `/teams/${TEAM}/projects/${PROJECT}/secrets`, {
    name: "blossom-secrets",
    type: "secret",
    secretType: "environment",
    priority: 10,
    restrictions: {
      restricted: true,
      nfObjects: [{ id: SERVICE, type: "service" }],
      tagMatchCondition: "or",
    },
    secrets: { variables },
  });
  console.log(r.status, redact(JSON.stringify(r.json || r.text)).slice(0, 1200));
  process.exit(r.status < 300 || r.status === 409 ? 0 : 1);
}

if (cmd === "get-service") {
  const r = await nf(token, "GET", `/teams/${TEAM}/projects/${PROJECT}/services/${SERVICE}`);
  const raw = JSON.stringify(r.json || r.text);
  console.log(r.status, redact(raw).slice(0, 2500));
  process.exit(r.status < 300 ? 0 : 1);
}

console.error("unknown cmd", cmd);
process.exit(2);
