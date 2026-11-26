const crypto = require("node:crypto");

const JOURNAL_KEY = "quant-pro:xauusd:manual-journal:v1";
const MAX_TRADES = 500;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validateOpenPayload(body, now = Date.now()) {
  const signal = body && body.signal;
  if (!signal || typeof signal !== "object") return { ok: false, error: "SIGNAL_REQUIRED" };
  if (signal.symbol !== "XAUUSD" && signal.symbol !== "XAU/USD") return { ok: false, error: "XAUUSD_ONLY" };
  if (signal.status !== "BUY" && signal.status !== "SELL") return { ok: false, error: "LIVE_BUY_OR_SELL_REQUIRED" };
  if (typeof signal.signalId !== "string" || !/^[A-Za-z0-9:_-]{8,160}$/.test(signal.signalId)) {
    return { ok: false, error: "SIGNAL_ID_INVALID" };
  }
  const expiry = Date.parse(signal.signalValidUntil || "");
  if (!Number.isFinite(expiry) || expiry <= now) return { ok: false, error: "SIGNAL_EXPIRED_OR_INVALID" };

  const fillPrice = Number(body.fillPrice);
  const stopLoss = Number(signal.sl);
  const takeProfit = Number(signal.tp);
  if (![fillPrice, stopLoss, takeProfit].every(Number.isFinite) ||
      fillPrice <= 0 || stopLoss <= 0 || takeProfit <= 0) {
    return { ok: false, error: "PRICE_FIELDS_INVALID" };
  }

  const side = signal.status;
  const correctGeometry = side === "BUY"
    ? stopLoss < fillPrice && takeProfit > fillPrice
    : stopLoss > fillPrice && takeProfit < fillPrice;
  if (!correctGeometry) return { ok: false, error: "FILL_PRICE_OUTSIDE_RISK_LEVELS" };

  const risk = Math.abs(fillPrice - stopLoss);
  const reward = Math.abs(takeProfit - fillPrice);
  const rr = reward / risk;
  if (!Number.isFinite(rr) || rr < 1.8) {
    return { ok: false, error: "ACTUAL_FILL_RR_BELOW_1_8", actualRiskReward: Number.isFinite(rr) ? +rr.toFixed(3) : null };
  }

  return {
    ok: true,
    trade: {
      tradeId: crypto.randomUUID(),
      signalId: signal.signalId,
      symbol: "XAUUSD",
      side,
      signalEntry: Number(signal.entry),
      fillPrice,
      stopLoss,
      takeProfit,
      actualFillRiskReward: +rr.toFixed(3),
      openedAt: new Date(now).toISOString(),
      status: "OPEN",
      costs: "NOT_INCLUDED",
      note: "Manuel MT5 gerçekleşme fiyatı; spread/komisyon/swap ayrıca girilmedi."
    }
  };
}

function validateClosePayload(body, now = Date.now()) {
  const tradeId = body && body.tradeId;
  const exitPrice = Number(body && body.exitPrice);
  if (typeof tradeId !== "string" || !/^[0-9a-f-]{36}$/i.test(tradeId)) {
    return { ok: false, error: "TRADE_ID_INVALID" };
  }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return { ok: false, error: "EXIT_PRICE_INVALID" };
  return { ok: true, tradeId, exitPrice, closedAt: new Date(now).toISOString() };
}

function calculateRealizedR(trade, exitPrice) {
  const risk = Math.abs(trade.fillPrice - trade.stopLoss);
  const pnl = trade.side === "BUY"
    ? exitPrice - trade.fillPrice
    : trade.fillPrice - exitPrice;
  return risk > 0 ? +(pnl / risk).toFixed(4) : null;
}

function parseRedisState(raw) {
  if (!raw) return { trades: [], activeTradeId: "" };
  const state = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!state || !Array.isArray(state.trades) || typeof state.activeTradeId !== "string") {
    throw new Error("JOURNAL_STATE_INVALID");
  }
  return state;
}

async function redisCommand(path, method, body, env) {
  const base = String(env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error("JOURNAL_STORAGE_NOT_CONFIGURED");
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("JOURNAL_STORAGE_UNAVAILABLE");
  const payload = await response.json();
  if (payload.error) throw new Error("JOURNAL_STORAGE_COMMAND_FAILED");
  return payload.result;
}

const MUTATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local state
if raw then
  state = cjson.decode(raw)
else
  state = { trades = {}, activeTradeId = '' }
end
local action = ARGV[1]
if action == 'open' then
  if state.activeTradeId ~= '' then
    return cjson.encode({ ok = false, error = 'ACTIVE_TRADE_EXISTS' })
  end
  local incoming = cjson.decode(ARGV[2])
  for _, trade in ipairs(state.trades) do
    if trade.signalId == incoming.signalId then
      return cjson.encode({ ok = false, error = 'SIGNAL_ALREADY_RECORDED' })
    end
  end
  table.insert(state.trades, incoming)
  state.activeTradeId = incoming.tradeId
elseif action == 'close' then
  if state.activeTradeId == '' then
    return cjson.encode({ ok = false, error = 'NO_ACTIVE_TRADE' })
  end
  local found = false
  for _, trade in ipairs(state.trades) do
    if trade.tradeId == state.activeTradeId and trade.status == 'OPEN' then
      local exitPrice = tonumber(ARGV[2])
      local risk = math.abs(tonumber(trade.fillPrice) - tonumber(trade.stopLoss))
      local pnl
      if trade.side == 'BUY' then
        pnl = exitPrice - tonumber(trade.fillPrice)
      else
        pnl = tonumber(trade.fillPrice) - exitPrice
      end
      trade.exitPrice = exitPrice
      trade.closedAt = ARGV[3]
      trade.realizedR = risk > 0 and math.floor((pnl / risk) * 10000 + 0.5) / 10000 or cjson.null
      trade.status = 'CLOSED'
      found = true
      break
    end
  end
  if not found then
    return cjson.encode({ ok = false, error = 'ACTIVE_TRADE_STATE_MISMATCH' })
  end
  state.activeTradeId = ''
else
  return cjson.encode({ ok = false, error = 'ACTION_INVALID' })
end
while #state.trades > tonumber(ARGV[4]) do
  if state.trades[1].status == 'OPEN' then break end
  table.remove(state.trades, 1)
end
redis.call('SET', KEYS[1], cjson.encode(state))
return cjson.encode({ ok = true, state = state })
`;

async function getState(env) {
  const raw = await redisCommand("/get/" + encodeURIComponent(JOURNAL_KEY), "GET", undefined, env);
  return parseRedisState(raw);
}

async function mutate(action, args, env) {
  const result = await redisCommand("/eval", "POST", [
    MUTATE_SCRIPT,
    "1",
    JOURNAL_KEY,
    action,
    ...args,
    String(MAX_TRADES)
  ], env);
  return typeof result === "string" ? JSON.parse(result) : result;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Vary", "Authorization");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const expected = process.env.JOURNAL_ACCESS_TOKEN;
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || Buffer.byteLength(expected) < 32 || !safeEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  try {
    if (req.method === "GET") {
      const state = await getState(process.env);
      return res.status(200).json({ ok: true, state });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.action === "open") {
      const validated = validateOpenPayload(body);
      if (!validated.ok) return res.status(400).json(validated);
      const result = await mutate("open", [JSON.stringify(validated.trade)], process.env);
      return res.status(result.ok ? 200 : 409).json(result);
    }
    if (body.action === "close") {
      const validated = validateClosePayload(body);
      if (!validated.ok) return res.status(400).json(validated);
      const result = await mutate("close", [
        String(validated.exitPrice),
        validated.closedAt
      ], process.env);
      if (result.ok) {
        const closed = result.state.trades.find(x => x.tradeId === result.state.trades.find(y => y.status === "CLOSED" && y.closedAt === validated.closedAt)?.tradeId);
        if (closed) closed.costs = "NOT_INCLUDED";
      }
      return res.status(result.ok ? 200 : 409).json(result);
    }
    return res.status(400).json({ ok: false, error: "ACTION_INVALID" });
  } catch (error) {
    const status = error.message === "JOURNAL_STORAGE_NOT_CONFIGURED" ? 503 : 502;
    return res.status(status).json({
      ok: false,
      error: error.message === "JOURNAL_STORAGE_NOT_CONFIGURED"
        ? "JOURNAL_STORAGE_NOT_CONFIGURED"
        : "JOURNAL_SERVICE_UNAVAILABLE"
    });
  }
};

module.exports.__test = {
  safeEqual,
  validateOpenPayload,
  validateClosePayload,
  calculateRealizedR,
  parseRedisState
};
