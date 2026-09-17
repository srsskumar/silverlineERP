-- One category, typed two ways.
--
-- Migration 057 folded the categories already in use into the lookup, taking
-- each distinct spelling as written. Production held both "Survey" and
-- "SURVEY", so the dropdown came back with two entries reading "Survey" —
-- and two identical-looking options are worse than one wrong one: somebody
-- picks whichever, the register splits down the middle, and every count of
-- survey equipment is quietly short.
--
-- Only exact case-insensitive matches are merged. A difference in case is a
-- difference in typing, not in meaning. Anything else — "Electronics" beside
-- "Electronic", say — is left alone, because deciding those are the same
-- thing is a judgement about somebody's register that a migration has no
-- business making silently.
--
-- The uppercase spelling wins: it is the convention the seeded codes use and
-- what a new entry validates as.

-- Point the assets at the surviving spelling first, so nothing is orphaned.
UPDATE assets a
   SET category = keep.code
  FROM asset_categories keep
  JOIN asset_categories drop_me
    ON drop_me.org_id = keep.org_id
   AND lower(drop_me.code) = lower(keep.code)
   AND drop_me.code <> keep.code
   AND keep.code = upper(keep.code)
 WHERE a.org_id = keep.org_id
   AND a.category = drop_me.code;

-- Then retire the variant. Deactivated rather than deleted: an organisation
-- that genuinely wants both can switch it back on, and nothing that once
-- pointed at it is left dangling.
UPDATE asset_categories drop_me
   SET active = false
  FROM asset_categories keep
 WHERE drop_me.org_id = keep.org_id
   AND lower(drop_me.code) = lower(keep.code)
   AND drop_me.code <> keep.code
   AND keep.code = upper(keep.code)
   AND drop_me.code <> upper(drop_me.code);

-- The same for types, which are seeded uppercase and could collide the same
-- way if an organisation adds one by hand.
UPDATE asset_types drop_me
   SET active = false
  FROM asset_types keep
 WHERE drop_me.org_id = keep.org_id
   AND lower(drop_me.code) = lower(keep.code)
   AND drop_me.code <> keep.code
   AND keep.code = upper(keep.code)
   AND drop_me.code <> upper(drop_me.code)
   AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.asset_type_id = drop_me.id);
