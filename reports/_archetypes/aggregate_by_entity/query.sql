-- aggregate_by_entity — one row per entity, whatever the window.
--
-- REPLACE the schema-qualified names below with your own. Everything else is
-- structure the contract checker requires; changing it will fail the build,
-- and each requirement is there for a reason worth reading first
-- (reports/_archetypes/README.md).
--
-- The GROUP BY happens HERE, in SQL, not in the model. That is the whole point
-- of this shape: a full year is a few hundred rows and nothing truncates, so a
-- broad question gets a complete answer. Its counterpart, detail_by_entity,
-- returns one row per record and is right for a single entity and wrong for a
-- quarter.
--
-- TOTAL_ROWS counts ENTITIES here, not records, because rows are entities — it
-- is what truncation is computed from, so it has to count the same thing the
-- LIMIT does.
WITH scoped AS (
    SELECT
        f.ENTITY_ID,
        f.ENTITY_NAME,
        f.AMOUNT_CENTS,
        f.EVENT_DATE
    FROM PRODUCTION.ANALYTICS.YOUR_FACT_TABLE f
    -- The tenant predicate. Required verbatim, exactly as deployment.yaml
    -- declares it. This one line is the isolation boundary.
    WHERE f.TENANT_ID = {{tenant_id}}
        AND f.EVENT_DATE BETWEEN {{start_date}} AND {{end_date}}
),
by_entity AS (
    SELECT
        s.ENTITY_NAME,
        -- TO_VARCHAR is deliberate: ids wide enough to overflow int64 arrive
        -- as numbers otherwise, and the shaper refuses a numeric id rather
        -- than pass on a value that has already lost precision.
        TO_VARCHAR(MAX(s.ENTITY_ID)) AS ENTITY_ID,
        COUNT(*) AS RECORDS,
        SUM(s.AMOUNT_CENTS) AS AMOUNT_CENTS,
        MAX(s.ENTITY_ID) AS SORT_ID
    FROM scoped s
    GROUP BY s.ENTITY_NAME
),
totals AS (
    SELECT
        COUNT(*) AS TOTAL_ROWS,
        COALESCE(SUM(RECORDS), 0) AS TOTAL_RECORDS,
        COALESCE(SUM(AMOUNT_CENTS), 0) AS TOTAL_AMOUNT,
        COUNT(*) AS TOTAL_ENTITIES,
        -- The tenant's earliest date in the window. Only `all_time` uses it:
        -- that window runs from a synthetic floor, and showing the floor would
        -- tell a customer their programme began years before it did. Computed
        -- over `scoped`, so it is the full-range minimum and the LIMIT cannot
        -- move it.
        TO_VARCHAR(
            (SELECT MIN(s2.EVENT_DATE) FROM scoped s2),
            'YYYY-MM-DD'
        ) AS FIRST_DATE
    FROM by_entity
)
SELECT
    -- The session-timezone drift guard. The plugin computes the date it
    -- expects independently and refuses if the warehouse disagrees, because a
    -- day-out answer is invisible in the output.
    CURRENT_DATE() AS REPORTED_DATE,
    g.ENTITY_NAME,
    g.ENTITY_ID,
    g.RECORDS,
    g.AMOUNT_CENTS,
    t.TOTAL_ROWS,
    t.TOTAL_RECORDS,
    t.TOTAL_AMOUNT,
    t.TOTAL_ENTITIES,
    t.FIRST_DATE
FROM by_entity g
CROSS JOIN totals t
-- Deterministic, and tie-broken all the way down: with a LIMIT, ordering
-- decides which rows survive truncation, so an unstable order means the same
-- question can return different rows.
ORDER BY g.AMOUNT_CENTS DESC, g.ENTITY_NAME, g.SORT_ID
LIMIT 500
