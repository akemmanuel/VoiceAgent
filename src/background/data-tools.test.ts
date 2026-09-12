import { describe, expect, test } from "bun:test";
import { parseDelimitedText } from "./data-tools";

describe("delimited data tool", () => {
  test("reads quoted CSV values without changing values into numbers", () => {
    const table = parseDelimitedText('customer,amount\n"Ada, Inc.",0012.50\nGrace,7');
    expect(table.headers).toEqual(["customer", "amount"]);
    expect(table.rows).toEqual([{ customer: "Ada, Inc.", amount: "0012.50" }, { customer: "Grace", amount: "7" }]);
  });

  test("detects TSV and ignores empty lines", () => {
    const table = parseDelimitedText("name\tstatus\nAda\topen\n\nGrace\tclosed\n");
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual({ name: "Grace", status: "closed" });
  });
});
