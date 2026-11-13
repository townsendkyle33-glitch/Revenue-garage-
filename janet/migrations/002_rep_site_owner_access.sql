-- Owner-only read access for a future Rep Site page (/manage/janet), mirroring the Lead Engine's le_owners model.
-- Being an administrator does NOT grant access: only rows in janet_owners do. The integrations table (encrypted
-- Google token) is never readable from a browser. Skipped automatically outside Rep Site's database.
DO $outer$
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.user_roles') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE 'Rep Site tables not found; skipping owner access policies';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.janet_owners (
    user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.janet_owners ENABLE ROW LEVEL SECURITY;
  GRANT SELECT ON public.janet_owners TO authenticated;
  DROP POLICY IF EXISTS janet_owners_self ON public.janet_owners;
  CREATE POLICY janet_owners_self ON public.janet_owners FOR SELECT TO authenticated USING (user_id = auth.uid());

  -- Same initial owner as the Lead Engine: the site's first administrator.
  INSERT INTO public.janet_owners (user_id)
  SELECT r.user_id FROM public.user_roles r JOIN public.profiles p ON p.id = r.user_id
  WHERE r.role = 'admin' ORDER BY p.created_at, r.user_id LIMIT 1
  ON CONFLICT DO NOTHING;

  CREATE OR REPLACE FUNCTION public.janet_is_owner(_user uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
    SELECT EXISTS (SELECT 1 FROM janet_owners o JOIN profiles p ON p.id = o.user_id
                   WHERE o.user_id = _user AND p.status = 'approved')
  $f$;
  REVOKE ALL ON FUNCTION public.janet_is_owner(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.janet_is_owner(uuid) TO authenticated;

  DECLARE t text;
  BEGIN
    FOREACH t IN ARRAY ARRAY['janet_settings','janet_conversations','janet_messages','janet_calls','janet_memories',
      'janet_tasks','janet_callbacks','janet_jobs','janet_dev_tickets','janet_pending_actions','janet_audit'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_read', t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.janet_is_owner(auth.uid()))', t || '_owner_read', t);
    END LOOP;
  END;
END $outer$;
