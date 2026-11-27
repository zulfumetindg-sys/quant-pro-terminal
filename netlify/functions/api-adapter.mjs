export function adaptHandler(handler) {
  return async function netlifyHandler(event) {
    const url = new URL(event.rawUrl || event.path, "https://netlify.local");
    const query = Object.fromEntries(url.searchParams.entries());
    const req = {
      method: event.httpMethod || "GET",
      query,
      headers: event.headers || {},
      body: event.body || null
    };

    let statusCode = 200;
    const headers = {};
    let body = "";
    const res = {
      setHeader(name, value) { headers[name] = value; return this; },
      status(code) { statusCode = code; return this; },
      json(value) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        body = JSON.stringify(value);
        return this;
      },
      send(value) { body = String(value); return this; },
      end(value = "") { body = String(value); return this; }
    };

    try {
      await handler(req, res);
      return { statusCode, headers, body };
    } catch (error) {
      return {
        statusCode: 500,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: false,
          error: "API_ADAPTER_FAILED",
          message: error?.message || "Unknown adapter error"
        })
      };
    }
  };
}
