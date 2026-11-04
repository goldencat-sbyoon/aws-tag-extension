import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loginUrl = process.env.BUILD_LOGIN_URL;
const apiBaseUrl = process.env.BUILD_API_BASE_URL;
const firefoxId = process.env.BUILD_FIREFOX_ID || "aws-tag-extension@example.invalid";

function parseHttps(value, name) {
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  return parsed;
}

const login = parseHttps(loginUrl, "BUILD_LOGIN_URL");
const api = parseHttps(apiBaseUrl, "BUILD_API_BASE_URL");
if (api.pathname === "/" || api.search || api.hash) {
  throw new Error("BUILD_API_BASE_URL must include the REST API stage path (e.g. /prod) without query/hash");
}

for (const browser of ["chrome", "firefox"]) {
  const dest = resolve(project, "dist", browser);
  await mkdir(dest, { recursive: true });
  for (const file of ["background.js", "content.js", "popup.html", "popup.js", "popup.css"]) {
    await cp(resolve(project, "extension", file), resolve(dest, file));
  }
  const manifest = {
    manifest_version: 3,
    name: "AWS Tag Extension",
    version: "0.2.0",
    description: "EC2 tag key suggestions from AWS Organizations Effective Tag Policy",
    permissions: ["storage", "activeTab"],
    host_permissions: [...new Set([login.origin + "/*", api.origin + "/*"])],
    content_scripts: [{
      matches: ["https://*.console.aws.amazon.com/ec2/*", "https://console.aws.amazon.com/ec2/*"],
      js: ["content.js"], run_at: "document_idle"
    }],
    action: { default_popup: "popup.html" },
    background: browser === "chrome" ? { service_worker: "background.js" } : { scripts: ["background.js"] }
  };
  if (browser === "firefox") {
    manifest.browser_specific_settings = { gecko: { id: firefoxId, strict_min_version: "128.0" } };
  }
  await writeFile(resolve(dest, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(resolve(dest, "config.json"), JSON.stringify({
    loginUrl: login.toString(), apiBaseUrl: api.toString().replace(/\/$/, "")
  }, null, 2) + "\n");
  console.log(`Built ${browser} extension in ${dest}`);
}
