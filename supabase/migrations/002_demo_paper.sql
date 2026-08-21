-- ============================================================
--  PariksaRakshak — demo paper
--  Run AFTER 001_schema.sql and after promoting your account to faculty.
--  Creates a live 30-minute paper with code DEMO-01 containing one of each
--  question type, so you can test the whole flow before touching Gemini.
--  Delete it later with:  delete from public.exams where exam_code = 'DEMO-01';
-- ============================================================

do $$
declare
  v_faculty uuid;
  v_exam    uuid;
  v_q       uuid;
begin
  select id into v_faculty from public.profiles where role = 'faculty'
   order by created_at limit 1;
  if v_faculty is null then
    raise exception 'No faculty account yet. Promote your account first, then re-run this.';
  end if;

  delete from public.exams where exam_code = 'DEMO-01';

  insert into public.exams (faculty_id, title, exam_code, duration_min,
                            starts_at, ends_at, is_published)
  values (v_faculty, 'Demo paper — check everything works', 'DEMO-01', 30,
          now() - interval '1 minute', now() + interval '7 days', true)
  returning id into v_exam;

  -- 1. multiple choice
  insert into public.questions (exam_id, qtype, position, marks, prompt, options, correct_key)
  values (v_exam, 'mcq', 1, 1,
    'Which data structure gives average O(1) lookup by key?',
    '["A) Linked list","B) Hash table","C) Binary search tree","D) Array"]'::jsonb,
    'B');

  -- 2. fill in the blanks
  insert into public.questions (exam_id, qtype, position, marks, prompt, cloze_answers)
  values (v_exam, 'cloze', 2, 1,
    'In SQL, the ____ clause filters rows before grouping and the ____ clause filters groups after it.',
    '["WHERE","HAVING"]'::jsonb);

  -- 3. long answer
  insert into public.questions (exam_id, qtype, position, marks, prompt)
  values (v_exam, 'long', 3, 5,
    'Explain, in your own words, why a database index speeds up reads but slows down writes.');

  -- 4. coding, with visible and hidden tests
  insert into public.questions (exam_id, qtype, position, marks, prompt, language, starter_code)
  values (v_exam, 'coding', 4, 10,
    E'Read a line of space-separated integers and print their sum.\n\nInput format\nOne line with space-separated integers.\n\nOutput format\nA single integer — the sum.\n\nExample\nInput:  1 2 3\nOutput: 6',
    'python',
    E'nums = list(map(int, input().split()))\n\n# TODO: print the sum of nums\n')
  returning id into v_q;

  insert into public.test_cases (question_id, stdin, expected_out, is_hidden, position) values
    (v_q, '1 2 3',        '6',    false, 1),
    (v_q, '10 20 30 40',  '100',  false, 2),
    (v_q, '5',            '5',    true,  3),
    (v_q, '-4 4',         '0',    true,  4),
    (v_q, '-1 -2 -3',     '-6',   true,  5),
    (v_q, '1000000 1000000', '2000000', true, 6);

  raise notice 'Demo paper ready. Exam code: DEMO-01';
end $$;
