// Creates a short-lived, one-time token for launching an exam in Safe Exam Browser.
// This function requires the student's normal Supabase session.
import { createClient } from "npm:@supabase/supabase-js@2";

// How long a launch link stays usable. Two minutes is long enough to approve the
// browser prompt and for SEB to start, and short enough that a copied link is
// worthless by the time anyone could pass it on.
const LAUNCH_TTL_MS = 2 * 60_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supaUser.auth.getUser();
    if (!user) return json({ error: "Sign in again before starting the exam." }, 401);

    const { data: profile } = await supaUser
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "student") {
      return json({ error: "Only student accounts can start an exam." }, 403);
    }

    const { exam_code } = await req.json();
    const code = String(exam_code ?? "").trim().toUpperCase();
    if (!code) return json({ error: "Enter the exam code." }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: exam } = await admin.from("exams")
      .select("id, exam_code, title, starts_at, ends_at, is_published")
      .eq("exam_code", code).maybeSingle();

    if (!exam || !exam.is_published) {
      return json({ error: "No published exam has that code." }, 404);
    }

    const now = Date.now();
    if (now < new Date(exam.starts_at).getTime()) {
      return json({ error: "This exam has not opened yet." }, 403);
    }
    if (now > new Date(exam.ends_at).getTime()) {
      return json({ error: "This exam has already closed." }, 403);
    }

    const { data: existing } = await admin.from("attempts")
      .select("status")
      .eq("exam_id", exam.id)
      .eq("student_id", user.id)
      .maybeSingle();
    if (existing?.status === "submitted") {
      return json({ error: "You have already submitted this paper." }, 403);
    }

    // Revoke older unused launch tokens for this student/exam, then issue a new one.
    await admin.from("seb_launch_tokens")
      .delete()
      .eq("student_id", user.id)
      .eq("exam_id", exam.id)
      .is("used_at", null);

    const raw = randomToken(32);
    const tokenHash = await sha256(raw);
    const expiresAt = new Date(Date.now() + LAUNCH_TTL_MS).toISOString();

    const { error } = await admin.from("seb_launch_tokens").insert({
      token_hash: tokenHash,
      student_id: user.id,
      exam_id: exam.id,
      expires_at: expiresAt,
    });
    if (error) return json({ error: "Could not prepare the secure launch." }, 500);

    return json({
      launch_token: raw,
      exam_code: exam.exam_code,
      expires_at: expiresAt,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function randomToken(bytes: number) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  buf.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
