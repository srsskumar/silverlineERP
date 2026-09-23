-- 089: where a control point actually is, in the surveyor's words.
--
-- A GCP's coordinates say where it is on the earth; nothing said where it is
-- on the ground, in words that let somebody else go and stand on it. "Tied
-- to BM 42" in the existing remarks is how it was fixed, not where to find
-- it -- a Panchayat office roof, a government hospital compound, a temple
-- gate. Two years on, with the pillar plastered over or the roof re-tiled,
-- the coordinates are still exact and finding the point is still a search
-- party, because nothing recorded a landmark.

ALTER TABLE survey_village_gcps
  ADD COLUMN IF NOT EXISTS landmark varchar(255);
