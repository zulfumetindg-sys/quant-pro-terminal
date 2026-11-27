import apiHandler from "../../api/signal-engine.js";
import { adaptHandler } from "./api-adapter.mjs";

export const handler = adaptHandler(apiHandler);
