// Load .env (KEY=value lines) into process.env without overriding real env vars.
import fs from "node:fs";

const file = new URL("../.env", import.meta.url);
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
