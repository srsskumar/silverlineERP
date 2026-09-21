import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { Pool } from "pg";
import { login, TIMING_DUMMY_HASH, UnknownUserError } from "../src/modules/auth/service.js";

/**
 * AUTH-11 -- an unknown name costs as much as a wrong password.
 *
 * A timing assertion would be flaky, so this checks the mechanism: the
 * refusal for a name that matches nobody still runs a full bcrypt compare,
 * against a hash at the application's cost.
 */

const nobodyHere = {
  pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
  jwtSecret: "unused",
};

afterEach(() => { vi.restoreAllMocks(); });

describe("signing in as nobody", () => {
  it("still compares a password before saying no", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    await expect(
      login(nobodyHere, { username: "ghost", password: "whatever-they-typed" }, { requestId: "t" }),
    ).rejects.toBeInstanceOf(UnknownUserError);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith("whatever-they-typed", TIMING_DUMMY_HASH);
  });

  it("compares against a hash at the cost real passwords use", () => {
    expect(bcrypt.getRounds(TIMING_DUMMY_HASH)).toBe(12);
  });
});
