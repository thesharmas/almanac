-- detail_by_entity — one row per record, for a single entity the customer names.
--
-- REPLACE the schema-qualified names below with your own.
--
-- This is the only archetype that uses {{entity}} — the one placeholder
-- carrying a value the MODEL chose rather than one the host derived. Two
-- things make that safe, and both are checked by the build rather than left to
-- review:
--
--   1. The tenant predicate is still mandatory and ANDed below, so this filter
--      can only ever narrow a result that is already scoped to one tenant. A
--      hostile or hallucinated name returns zero rows — never another
--      tenant's.
--   2. The filter must appear in exactly the form deployment.yaml declares as
--      `tenancy.entityPredicate`. A template cannot invent its own spelling,
--      so there is no way to write one that compares the model's value against
--      a different column.
--
-- The encoder does the rest: it permit-lists the characters, doubles
-- apostrophes, and adds the LIKE wildcards itself so a report cannot choose a
-- different matching strategy.
WITH scoped AS (
    SELECT
        f.RECORD_ID,
        f.ENTITY_NAME,
        f.AMOUNT_CENTS,
        f.EVENT_DATE
    FROM PRODUCTION.ANALYTICS.YOUR_FACT_TABLE f
    WHERE f.TENANT_ID = {{tenant_id}}
        AND f.EVENT_DATE BETWEEN {{start_date}} AND {{end_date}}
        AND UPPER(f.ENTITY_NAME) LIKE UPPER({{entity}})
),
totals AS (
    SELECT
        COUNT(*) AS TOTAL_ROWS,
        COUNT(DISTINCT RECORD_ID) AS TOTAL_RECORDS,
        COALESCE(SUM(AMOUNT_CENTS), 0) AS TOTAL_AMOUNT
    FROM scoped
)
SELECT
    CURRENT_DATE() AS REPORTED_DATE,
    s.EVENT_DATE,
    TO_VARCHAR(s.RECORD_ID) AS RECORD_ID,
    s.ENTITY_NAME,
    s.AMOUNT_CENTS,
    t.TOTAL_ROWS,
    t.TOTAL_RECORDS,
    t.TOTAL_AMOUNT
FROM scoped s
CROSS JOIN totals t
-- Newest first, tie-broken by reference. When this report truncates — and it
-- will — the customer keeps the most recent records rather than an arbitrary
-- subset.
ORDER BY s.EVENT_DATE DESC, s.RECORD_ID
LIMIT 1500
