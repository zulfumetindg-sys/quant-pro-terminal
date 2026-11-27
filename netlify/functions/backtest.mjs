import apiHandler from "../../api/backtest.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { adaptHandler } = require("./api-adapter.cjs");
export const handler = adaptHandler(apiHandler);
