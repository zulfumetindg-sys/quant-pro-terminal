#property strict
#property version   "1.00"
#property description "QUANT PRO XM read-only quote bridge. Never sends or modifies orders."

input string BridgeUrl = "https://quant-pro-terminal-ecru.vercel.app/api/xm-bridge";
input string BridgeToken = "";
input string TradeSymbol = "GOLDm#";
input int SendIntervalSeconds = 5;

datetime lastSend = 0;

string JsonEscape(string value) {
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   return value;
}

bool SendSnapshot() {
   if(BridgeToken == "") {
      Print("QUANT PRO: BridgeToken is empty; configure a separate bridge token.");
      return false;
   }
   if(!SymbolSelect(TradeSymbol, true)) {
      Print("QUANT PRO: symbol unavailable: ", TradeSymbol);
      return false;
   }

   MqlTick tick;
   if(!SymbolInfoTick(TradeSymbol, tick) || tick.bid <= 0 || tick.ask < tick.bid)
      return false;

   string currency = AccountInfoString(ACCOUNT_CURRENCY);
   if(currency != "EUR") {
      Print("QUANT PRO: account currency must be EUR for this bridge profile.");
      return false;
   }

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double contractSize = SymbolInfoDouble(TradeSymbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double tickSize = SymbolInfoDouble(TradeSymbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(TradeSymbol, SYMBOL_TRADE_TICK_VALUE);
   double minVolume = SymbolInfoDouble(TradeSymbol, SYMBOL_VOLUME_MIN);
   double volumeStep = SymbolInfoDouble(TradeSymbol, SYMBOL_VOLUME_STEP);
   if(balance <= 0 || contractSize <= 0 || tickSize <= 0 || tickValue <= 0 ||
      minVolume <= 0 || volumeStep <= 0) return false;

   string stamp = TimeToString(TimeGMT(), TIME_DATE|TIME_SECONDS);
   StringReplace(stamp, ".", "-");
   string payload = StringFormat(
      "{\"schemaVersion\":1,\"source\":\"XM_MT5_READ_ONLY_EA\",\"symbol\":\"%s\",\"timestamp\":\"%sZ\",\"bid\":%.10f,\"ask\":%.10f,\"balance\":%.2f,\"accountCurrency\":\"EUR\",\"contractSize\":%.10f,\"tickSize\":%.10f,\"tickValue\":%.10f,\"minVolume\":%.4f,\"volumeStep\":%.4f}",
      JsonEscape(TradeSymbol), stamp, tick.bid, tick.ask, balance,
      contractSize, tickSize, tickValue, minVolume, volumeStep
   );

   char data[];
   int copied = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(copied <= 1) return false;
   ArrayResize(data, copied - 1);

   char result[];
   string responseHeaders;
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + BridgeToken + "\r\n";
   ResetLastError();
   int status = WebRequest("POST", BridgeUrl, headers, 8000, data, result, responseHeaders);
   if(status != 200) {
      Print("QUANT PRO bridge HTTP status=", status, " error=", GetLastError());
      return false;
   }
   return true;
}

int OnInit() {
   if(TradeSymbol != "GOLDm#") {
      Print("This read-only bridge is restricted to GOLDm#.");
      return INIT_FAILED;
   }
   EventSetTimer(MathMax(5, SendIntervalSeconds));
   Print("QUANT PRO read-only bridge started. Trading functions are intentionally absent.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { SendSnapshot(); }
