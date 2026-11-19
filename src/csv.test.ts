import { expect, test } from "bun:test";
import { parseCsv } from "./csv";

test("keeps commas, escaped quotes, and newlines inside message text", () => {
  const csv = 'MsgID,Text,RealName\r\n1.1,"hi, ""you""\nline two",Ann\n2.2,plain,\n';
  expect(parseCsv(csv)).toEqual([
    { MsgID: "1.1", Text: 'hi, "you"\nline two', RealName: "Ann" },
    { MsgID: "2.2", Text: "plain", RealName: "" },
  ]);
});

test("rejects truncated output instead of dropping the last message", () => {
  expect(() => parseCsv('MsgID,Text\n1.1,"cut off')).toThrow("unterminated");
});
