import { expect, test } from "bun:test";
import { meetings } from "./agenda";

const event = (text: string) => ({
  type: "section",
  text: { type: "mrkdwn", text },
  accessory: { type: "overflow" },
});

test("meetings reads events from an Outlook Calendar Home tab render", () => {
  const blocks = [
    { type: "section", text: { text: "*<!date^1795503600^{date_long_pretty}|Tuesday>*" } },
    { type: "actions" },
    event(
      " *<https://outlook.office365.com/owa/?itemid=B&amp;path=/calendar/item|Q&amp;A &lt;sync&gt;>* (_me@example.com_)\n<!date^1795546800^{time}|11/24/26>-<!date^1795548600^{time}|11/24/26>",
    ),
    { type: "divider" },
    event(
      " *<https://outlook.office365.com/owa/?itemid=A&amp;path=/calendar/item|Busy>* (_me@example.com_)\n<!date^1795543200^{time}|11/24/26>-<!date^1795545000^{time}|11/24/26>",
    ),
    { type: "section", text: { text: "Your schedule for *today* is empty" } },
  ];
  expect(meetings(blocks)).toEqual([
    { title: "Busy", start: new Date(1795543200_000), end: new Date(1795545000_000) },
    { title: "Q&A <sync>", start: new Date(1795546800_000), end: new Date(1795548600_000) },
  ]);
});
