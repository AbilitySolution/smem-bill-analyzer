-- consumption_history.periode_date holds month-level labels (e.g. "2022-02")
-- extracted from invoice header tables that only show month/year, not a day.
alter table consumption_history
  alter column periode_date type text using periode_date::text;
