import apiHandler from "../../api/backtest.js";
import { adaptHandler } from "./api-adapter.mjs";

export const handler = adaptHandler(apiHandler);
