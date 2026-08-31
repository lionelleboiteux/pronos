-- 20260831120000_add_project_to_feedback.sql — expand-only (ADR-0003).
-- DNP and compos now share pronos's /v1/feedback endpoint (fc-shared's
-- <fc-feedback>) instead of each having their own backend. `project`
-- distinguishes which site a submission came from; existing rows default to
-- 'pronos' since that was the only site with a feedback box before this.

alter table feedback add column if not exists project text not null default 'pronos';
