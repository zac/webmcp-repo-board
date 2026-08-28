import { describe, expect, it } from "vitest";
import { repositoryGateCopy } from "./App";

describe("repository access gate", () => {
  it("asks a logged-out viewer to sign in without confirming repository existence", () => {
    expect(repositoryGateCopy(false)).toEqual({
      eyebrow: "Sign in required",
      title: "This repository may be private or unavailable.",
      body: "Sign in with GitHub so Repo Board can check whether you have access.",
    });
  });

  it("guides a logged-in viewer toward account or app access without confirming repository existence", () => {
    expect(repositoryGateCopy(true)).toEqual({
      eyebrow: "Repository unavailable",
      title: "Repo Board couldn’t verify access.",
      body: "The repository may not exist, your account may not have access, or the GitHub App may need permission for it.",
    });
  });
});
