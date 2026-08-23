// supabase/functions/session-check/index.ts
//
// One live session per student per paper. The exam page calls this on a
// heartbeat; if the answer is `revoked`, someone opened the same paper
// somewhere else and this copy locks itself.
//
// Deploy with --no-verify-jwt: it authenticates by session token, not by JWT.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const { session_token } = await req.json();
    const raw = String(session_token ?? "");

    if (raw.length < 32 || raw.length > 200) {
      return json({ active: false, reason: "no_session" });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const hash = await sha256(raw);

    const { data: row } = await admin
      .from("seb_exam_sessions")
      .select("id, revoked_at, expires_at")
      .eq("session_hash", hash)
      .maybeSingle();

    if (!row) {
      return json({ active: false, reason: "unknown" });
    }

    if (row.revoked_at) {
      return json({ active: false, reason: "revoked" });
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return json({ active: false, reason: "expired" });
    }

    await admin
      .from("seb_exam_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", row.id);

    return json({ active: true });
  } catch (e) {
    console.error(e);

    // Fail open so a temporary backend problem does not remove
    // the student's paper during an exam.
    return json({ active: true, degraded: true });
  }
});

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}