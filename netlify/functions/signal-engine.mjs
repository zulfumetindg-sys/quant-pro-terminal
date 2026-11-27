import apiHandler from "../../api/signal-engine.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { adaptHandler } = require("./api-adapter.cjs");
export const handler = adaptHandler(apiHandler);
