-- 20260831140000_add_pseudo_email_to_feedback.sql — expand-only (ADR-0003).
-- fc-shared's <fc-feedback> now optionally collects a pseudo/email so Lio
-- knows who to reply to; both nullable since neither is required.

alter table feedback add column if not exists pseudo text;
alter table feedback add column if not exists email text;
