import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = join(__dirname, "..");
export const AGENTS_DIR = join(PROJECT_ROOT, "agents");
