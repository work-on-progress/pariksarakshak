// Verifies the URL-specific Config Key hash exposed by the SEB JavaScript API.
// The raw Config Key is stored only as a Supabase Edge Function secret.
// Deploy this function with JWT verification disabled.
const CONFIG_KEY = (Deno.env.get("SEB_CONFIG_KEY") ?? "").trim().toLowerCase();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    if (!/^[0-9a-f]{64}$/.test(CONFIG_KEY)) {
      // Named so the page can tell "not set up yet" from "wrong config".
      return json({
        error: "SEB server verification is not configured yet.",
        code: "not_configured",
      }, 503);
    }

    const { url, config_key_hash, version } = await req.json();
    const absoluteUrl = String(url ?? "").split("#")[0];
    const received = String(config_key_hash ?? "").trim().toLowerCase();

    if (!/^https:\/\//i.test(absoluteUrl) || !/^[0-9a-f]{64}$/.test(received)) {
      return json({ error: "Invalid Safe Exam Browser evidence." }, 400);
    }

    const expected = await sha256(`${absoluteUrl}${CONFIG_KEY}`);
    if (!constantTimeEqual(expected, received)) {
      return json({ error: "Safe Exam Browser is not using the approved exam configuration." }, 403);
    }

    return json({ ok: true, version: String(version ?? "").slice(0, 120) });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
