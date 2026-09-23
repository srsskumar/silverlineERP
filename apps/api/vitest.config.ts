import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    /*
     * One fork, on purpose, and measured.
     *
     * Most of this suite's wall time is setup: fifty-nine files that each
     * truncate and reseed, about three seconds apiece. The obvious fix was to
     * run them at once against a database per worker, and it was tried — four
     * workers took 392 seconds where one took 310, because the bottleneck is
     * one Postgres doing the writes rather than the CPU doing the work, and
     * four concurrent seeds simply queue behind each other with overhead on
     * top. The machinery for it is still in test/database.ts if the database
     * ever moves somewhere that can absorb it.
     *
     * What did help is in globalSetup: the test databases are told not to
     * wait for the disk on commit, which is free on data that is thrown away.
     */
    globalSetup: ["./test/globalSetup.ts"],
    /*
     * The worker names punch places through a public geocoder. Every suite
     * that runs a worker pass would otherwise reach the internet, one second
     * per positioned punch; the job's own test stubs fetch and turns this
     * back on for itself.
     */
    env: { GEOCODING_REVERSE: "off" },
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
