/*
 * §087 -- the stage §086 added is called "13 Notification", not "Notification".
 *
 * The number is not decoration: it is the position on the thirteen-item
 * ladder the contract and the dashboard both count against, the same way
 * "13 Notification issued" already names the rung it completes to. A stage
 * picker that said plain "Notification" beside a ladder that said "13
 * Notification issued" would read as two different things.
 *
 * 086 ran before this was noticed, so the label it wrote is corrected here
 * rather than editing 086 itself -- a migration that already ran is a
 * historical record of what this database was told to do, not a draft.
 */
UPDATE survey_stages SET label = '13 Notification'
WHERE code = 'NOTIFICATION' AND label = 'Notification';
