-- One-off: remove the orphan invoice row left by a failed save attempt
-- (insert succeeded, child-table inserts failed before the app started
-- compensating). User-confirmed: facture_number 12634845E has no rows in
-- any child table.
delete from invoices where facture_number = '12634845E';
