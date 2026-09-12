import { describe, expect, test } from "bun:test";
import { negotiateCall } from "./call";

describe("GPT-Live call negotiation", () => {
  test("sends the selected voice in the session", async () => {
    let body: any;
    const answer = await negotiateCall(
      "v=0\r\no=offer",
      { accessToken: "token", accountId: "account" },
      new AbortController().signal,
      "juniper",
      async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response("v=0\r\no=answer");
      },
    );

    expect(answer).toStartWith("v=0");
    expect(body.session.audio.output.voice).toBe("juniper");
  });
});
