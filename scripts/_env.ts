// Loads .env.local then .env for CLI scripts (Next.js does this itself for the app).
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
