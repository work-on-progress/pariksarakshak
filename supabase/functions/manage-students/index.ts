// supabase/functions/manage-students/index.ts
// Creates student accounts in bulk from a roll list, and resets a password.
// Only a faculty token may call it. Uses the service role key, which lives in
// Supabase and never reaches a browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// No look-alike characters: a student typing this from a slip should not have
// to guess between 0 and O, or 1 and l.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function makePassword(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ---- 1. faculty only ----
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supaUser.auth.getUser();
    if (!user) return json({ error: "Sign in again — the session has expired." }, 401);

    const { data: profile } = await supaUser
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "faculty") {
      return json({ error: "Only faculty accounts can manage students." }, 403);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const action = body.action ?? "create";

    // ---- 2. create accounts from a roll list ----
    if (action === "create") {
      const students = Array.isArray(body.students) ? body.students : [];
      const domain = (body.email_domain ?? "exam.local").replace(/^@/, "");
      if (!students.length) return json({ error: "The list was empty." }, 400);
      if (students.length > 300) return json({ error: "Do at most 300 at a time." }, 400);

      const created: Array<Record<string, string>> = [];
      const skipped: Array<Record<string, string>> = [];

      for (const s of students) {
        const roll = String(s.roll_no ?? "").trim();
        const name = String(s.full_name ?? "").trim();
        if (!roll) { skipped.push({ roll_no: "", reason: "no roll number" }); continue; }

        const email = (s.email && String(s.email).trim()) ||
          `${roll.toLowerCase().replace(/[^a-z0-9]/g, "")}@${domain}`;
        const password = makePassword();

        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: name, roll_no: roll },
        });

        if (error) {
          skipped.push({ roll_no: roll, email, reason: error.message });
          continue;
        }

        // The signup trigger writes the profile; make sure the roll and name
        // are there even if the trigger ran before the metadata was attached.
        await admin.from("profiles")
          .update({ full_name: name, roll_no: roll })
          .eq("id", data.user!.id);

        created.push({ roll_no: roll, full_name: name, email, password });
      }

      return json({ created, skipped, count: created.length });
    }

    // ---- 3. reset one password ----
    if (action === "reset_password") {
      const roll = String(body.roll_no ?? "").trim();
      if (!roll) return json({ error: "Give the roll number to reset." }, 400);

      const { data: p } = await admin.from("profiles")
        .select("id, full_name").eq("roll_no", roll).single();
      if (!p) return json({ error: `No student with roll number ${roll}.` }, 404);

      const password = makePassword();
      const { error } = await admin.auth.admin.updateUserById(p.id, { password });
      if (error) return json({ error: error.message }, 500);

      return json({ roll_no: roll, full_name: p.full_name, password });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
