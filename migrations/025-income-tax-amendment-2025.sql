-- 025 — Employment income tax: the Income Tax (Amendment) Proclamation rates.
--
-- Ethiopia amended the income tax schedule in 2025 with effect from 7 July
-- 2025. The exemption threshold for monthly employment income rose from ETB
-- 600 to ETB 2,000 and every band above it moved. The table stored until now
-- was the Proclamation 979/2016 schedule — correct when it was seeded, and
-- since the amendment it has been over-deducting from every payslip the
-- engine computed.
--
-- Monthly employment income (ETB)        Rate
--   0        –   2,000                    0%   (exempt)
--   2,001    –   4,000                   15%
--   4,001    –   7,000                   20%
--   7,001    –  10,000                   25%
--  10,001    –  14,000                   30%
--  above 14,000                          35%
--
-- The `deduct` column is the constant that makes tax = rate × pay − deduct
-- continuous across the band edges, so the stored table can be checked
-- against the published schedule directly rather than reverse-engineered
-- (the same form the PAYE tables are printed in):
--   deduct(band) = rate(band) × lower(band) − cumulative(top of previous band)
--   e.g. band 15%: 0.15 × 2,000 − 0            = 300
--        band 20%: 0.20 × 4,000 − 300          = 500
--        band 25%: 0.25 × 7,000 − 900          = 850
--        band 30%: 0.30 × 10,000 − 1,650       = 1,350
--        band 35%: 0.35 × 14,000 − 2,850       = 2,050
--
-- `payroll._unverified` is deliberately NOT cleared here: the rate table now
-- matches the amended proclamation, but confirming that is the accountant's
-- judgement, not a migration's. Payroll output stays marked provisional until
-- they set the flag to false in Settings.
--
-- Apply with:
--   npx wrangler d1 execute fufut-db --remote --file=migrations/025-income-tax-amendment-2025.sql
-- (Production rows are also updated at runtime through the audited
-- PUT /api/settings/tax.income_bands, which records who changed what.)

UPDATE settings
   SET value = '[{"upTo":2000,"rate":0,"deduct":0},{"upTo":4000,"rate":0.15,"deduct":300},{"upTo":7000,"rate":0.20,"deduct":500},{"upTo":10000,"rate":0.25,"deduct":850},{"upTo":14000,"rate":0.30,"deduct":1350},{"upTo":null,"rate":0.35,"deduct":2050}]',
       description = 'Monthly employment income bands per the Income Tax (Amendment) Proclamation effective 7 July 2025. upTo null is the top band.',
       updated_at = datetime('now'),
       updated_by = 'migration 025'
 WHERE key = 'tax.income_bands';
