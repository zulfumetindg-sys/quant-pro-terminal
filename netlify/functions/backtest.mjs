import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createApiHandler } = require("./api-adapter.cjs");
export const handler = createApiHandler("../../api/backtest.js");
