// supabase/functions/manage-students/index.ts
// Faculty-only student account management.
// Supports bulk create, password reset, profile/login edit, and full deletion.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function makePassword(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function cleanRoll(value: unknown) {
  return String(value ?? "").trim();
}
function cleanName(value: unknown) {
  return String(value ?? "").trim();
}
function loginForRoll(roll: string, domain: string) {
  return `${roll.toLowerCase().replace(/[^a-z0-9]/g, "")}@${domain}`;
}

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
    const action = String(body.action ?? "create");

    if (action === "create") {
      const students = Array.isArray(body.students) ? body.students : [];
      const domain = String(body.email_domain ?? "exam.local").replace(/^@/, "");
      if (!students.length) return json({ error: "The list was empty." }, 400);
      if (students.length > 300) return json({ error: "Do at most 300 at a time." }, 400);

      const created: Array<Record<string, string>> = [];
      const skipped: Array<Record<string, string>> = [];

      for (const s of students) {
        const roll = cleanRoll(s.roll_no);
        const name = cleanName(s.full_name);
        if (!roll) {
          skipped.push({ roll_no: "", reason: "no roll number" });
          continue;
        }

        const email = (s.email && String(s.email).trim()) || loginForRoll(roll, domain);
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

        await admin.from("profiles")
          .update({ full_name: name, roll_no: roll })
          .eq("id", data.user!.id);

        created.push({ roll_no: roll, full_name: name, email, password });
      }

      return json({ created, skipped, count: created.length });
    }

    if (action === "reset_password") {
      const roll = cleanRoll(body.roll_no);
      if (!roll) return json({ error: "Give the roll number to reset." }, 400);

      const { data: p } = await admin.from("profiles")
        .select("id, full_name, role").eq("roll_no", roll).single();
      if (!p || p.role !== "student") {
        return json({ error: `No student with roll number ${roll}.` }, 404);
      }

      const password = makePassword();
      const { error } = await admin.auth.admin.updateUserById(p.id, { password });
      if (error) return json({ error: error.message }, 500);

      return json({ roll_no: roll, full_name: p.full_name, password });
    }

    if (action === "update") {
      const studentId = String(body.student_id ?? "");
      const roll = cleanRoll(body.roll_no);
      const name = cleanName(body.full_name);
      const domain = String(body.email_domain ?? "exam.local").replace(/^@/, "");

      if (!studentId || !roll) {
        return json({ error: "Student id and roll number are required." }, 400);
      }

      const { data: p } = await admin.from("profiles")
        .select("id, role").eq("id", studentId).single();
      if (!p || p.role !== "student") {
        return json({ error: "Student not found." }, 404);
      }

      const { data: duplicate } = await admin.from("profiles")
        .select("id").eq("roll_no", roll).neq("id", studentId).maybeSingle();
      if (duplicate) return json({ error: `Roll number ${roll} is already in use.` }, 409);

      const email = loginForRoll(roll, domain);
      const { error: authError } = await admin.auth.admin.updateUserById(studentId, {
        email,
        user_metadata: { full_name: name, roll_no: roll },
      });
      if (authError) return json({ error: authError.message }, 500);

      const { error: profileError } = await admin.from("profiles")
        .update({ full_name: name, roll_no: roll })
        .eq("id", studentId);
      if (profileError) return json({ error: profileError.message }, 500);

      return json({ updated: true, student_id: studentId, roll_no: roll, full_name: name, email });
    }

    if (action === "delete") {
      const studentId = String(body.student_id ?? "");
      if (!studentId) return json({ error: "Student id is required." }, 400);

      const { data: p } = await admin.from("profiles")
        .select("id, role, full_name, roll_no").eq("id", studentId).single();
      if (!p || p.role !== "student") return json({ error: "Student not found." }, 404);

      // Remove attempt-owned rows first because attempts.student_id does not cascade.
      const { data: attempts } = await admin.from("attempts")
        .select("id").eq("student_id", studentId);
      const attemptIds = (attempts ?? []).map((a) => a.id);

      if (attemptIds.length) {
        await admin.from("answers").delete().in("attempt_id", attemptIds);
        await admin.from("incident_logs").delete().in("attempt_id", attemptIds);
        await admin.from("attempts").delete().in("id", attemptIds);
      }

      await admin.from("seb_exam_sessions").delete().eq("student_id", studentId);
      await admin.from("seb_launch_tokens").delete().eq("student_id", studentId);

      const { error: deleteAuthError } = await admin.auth.admin.deleteUser(studentId);
      if (deleteAuthError) return json({ error: deleteAuthError.message }, 500);

      // profiles row is ON DELETE CASCADE from auth.users, but this keeps older schemas tidy too.
      await admin.from("profiles").delete().eq("id", studentId);

      return json({ deleted: true, student_id: studentId, roll_no: p.roll_no, full_name: p.full_name });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

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
